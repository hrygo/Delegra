import { and, eq, inArray } from "drizzle-orm";
import { companyMemberships, companySecrets, connectionGrants, toolConnections, type Db } from "@paperclipai/db";
import { aiBillingConfigurationSchema, aiConnectionMetadataSchema, updateAiBillingSchema, type AiBillingConfiguration, type UpdateAiBilling } from "@paperclipai/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { withAccountingTransaction } from "./accounting-transaction.js";
import { logActivity } from "./activity-log.js";
import { receiptFingerprint } from "./receipt-fingerprint.js";

type Connection = typeof toolConnections.$inferSelect;
export function readAiBilling(config: Record<string, unknown>): AiBillingConfiguration | null {
  const parsed = aiBillingConfigurationSchema.safeParse(config.aiBilling);
  return parsed.success ? parsed.data : null;
}

// Only metadata is read: never resolve, copy or hash credential values.
export interface AdoptedAiCredential { secretId: string; version: number; epoch: number }
async function bindingFingerprint(db: Db, connection: Connection, adopted?: AdoptedAiCredential) {
  const grants = await db.select().from(connectionGrants).where(and(eq(connectionGrants.companyId, connection.companyId), eq(connectionGrants.connectionId, connection.id)));
  const refs = [...connection.credentialRefs, ...connection.credentialSecretRefs, ...grants.flatMap(grant => grant.credentialSecretRefs)];
  const ids = [...new Set(refs.map(ref => ref.secretId))].sort();
  const credentials = ids.length ? await db.select({ id: companySecrets.id, version: companySecrets.latestVersion, epoch: companySecrets.aiSessionEpoch, status: companySecrets.status })
    .from(companySecrets).where(and(eq(companySecrets.companyId, connection.companyId), inArray(companySecrets.id, ids))).orderBy(companySecrets.id) : [];
  return receiptFingerprint({ companyId: connection.companyId, connectionId: connection.id, ai: connection.config.ai,
    authKind: connection.authKind, credentialPolicy: connection.credentialPolicy, refs, credentials: credentials.map(item => item.id === adopted?.secretId ? { ...item, version: adopted.version, epoch: adopted.epoch } : item),
    grants: grants.sort((a,b) => a.id.localeCompare(b.id)).map(grant => ({ id: grant.id, kind: grant.kind, owner: grant.subjectUserId, status: grant.status, refs: grant.credentialSecretRefs, externalCredential: grant.externalCredential })) });
}

/** Return an explicit tombstone when the confirmed relationship no longer matches. */
export async function effectiveAiBilling(db: Db, connection: Connection, adopted?: AdoptedAiCredential): Promise<AiBillingConfiguration | null> {
  const billing = readAiBilling(connection.config);
  if (!billing?.declaration) return billing;
  return billing.bindingFingerprint === await bindingFingerprint(db, connection, adopted) ? billing : { ...billing, declaration: null };
}

export function aiConnectionBillingService(db: Db) {
  async function authorize(database: Db, connection: Connection, userId: string, instanceAdmin: boolean) {
    const [member] = await database.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, connection.companyId), eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, userId), eq(companyMemberships.status, "active")));
    if (member?.membershipRole === "viewer") throw forbidden("Viewers cannot manage billing declarations");
    if (instanceAdmin || member?.membershipRole === "owner" || member?.membershipRole === "admin") return;
    const [ownedGrant] = await database.select({ id: connectionGrants.id }).from(connectionGrants).where(and(eq(connectionGrants.companyId, connection.companyId), eq(connectionGrants.connectionId, connection.id), eq(connectionGrants.subjectUserId, userId)));
    if (!ownedGrant && connection.createdByUserId !== userId) throw forbidden("Only the AI connection owner or an administrator can manage its billing declaration");
  }
  async function find(database: Db, companyId: string, connectionId: string, lock = false) {
    const query = database.select().from(toolConnections).where(and(eq(toolConnections.companyId, companyId), eq(toolConnections.id, connectionId), eq(toolConnections.connectionPurpose, "ai")));
    const [connection] = await (lock ? query.for("update") : query);
    if (!connection) throw notFound("AI connection not found");
    return connection;
  }
  return {
    async get(companyId: string, connectionId: string, userId: string, instanceAdmin = false) {
      const connection = await find(db, companyId, connectionId);
      await authorize(db, connection, userId, instanceAdmin);
      const configuration = readAiBilling(connection.config);
      return { configuration, effective: await effectiveAiBilling(db, connection) };
    },
    async put(companyId: string, connectionId: string, raw: UpdateAiBilling, userId: string, instanceAdmin = false) {
      const input = updateAiBillingSchema.parse(raw);
      return withAccountingTransaction(db, companyId, async (tx, publications) => {
        const connection = await find(tx, companyId, connectionId, true);
        await authorize(tx, connection, userId, instanceAdmin);
        const ai = aiConnectionMetadataSchema.safeParse(connection.config.ai);
        if (!ai.success || ai.data.provider !== "openai" || ai.data.method !== "api_key" || !ai.data.routing || ai.data.routing.protocol !== "responses")
          throw unprocessable("Billing declarations require a managed OpenAI-compatible Responses API-key connection");
        const before = readAiBilling(connection.config);
        if ((before?.revision ?? null) !== input.expectedRevision) throw conflict("Billing declaration changed since review");
        const after: AiBillingConfiguration = { revision: (before?.revision ?? 0) + 1, declaration: input.declaration,
          bindingFingerprint: await bindingFingerprint(tx, connection), updatedAt: new Date().toISOString(), updatedByUserId: userId };
        await tx.update(toolConnections).set({ config: { ...connection.config, aiBilling: after }, updatedAt: new Date() }).where(eq(toolConnections.id, connectionId));
        await logActivity(tx, { companyId, actorType: "user", actorId: userId, action: "ai_connection.billing_declared", entityType: "tool_connection", entityId: connectionId,
          details: { before, after } }, publications);
        return { configuration: after, effective: after };
      });
    },
  };
}

/** Legacy runs without a saved declaration stay undeclared on replay. */
export function freezeAiBillingSnapshot(current: AiBillingConfiguration | null | undefined, recovering: boolean, saved: unknown): AiBillingConfiguration | null {
  if (!recovering) return current ?? null;
  const parsed = aiBillingConfigurationSchema.safeParse(saved);
  return parsed.success ? parsed.data : null;
}

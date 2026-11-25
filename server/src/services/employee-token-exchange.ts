import {
  createHmac,
  createPublicKey,
  randomUUID,
  timingSafeEqual,
  verify as cryptoVerify,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";
import { and, eq } from "drizzle-orm";
import { authAccounts, companyMemberships, type Db } from "@paperclipai/db";
import { resolvePaperclipInstanceId } from "../home-paths.js";
import {
  EmployeeExpertsError,
  type EmployeeCredentialContext,
} from "./employee-experts.js";

/**
 * Frozen RFC 8693 OAuth 2.0 Token Exchange contract constants
 * (CORP-DSH-EXPERT-001 §2.1–§2.3, §9.3).
 */
export const EMPLOYEE_TOKEN_EXCHANGE_PATH = "/oauth/token-exchange";
export const TOKEN_EXCHANGE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange";
export const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
export const MAX_EXCHANGED_TOKEN_TTL_SECONDS = 300;
export const EMPLOYEE_ACCESS_TOKEN_TYPE = "delegra_employee_access";

const ALLOWED_IAM_ALGS = new Set(["RS256", "ES256", "EdDSA"]);
const EXCHANGED_TOKEN_ALG = "HS256";
const DEFAULT_JWKS_CACHE_TTL_MS = 5 * 60 * 1000;
const CLOCK_SKEW_SECONDS = 30;

export interface EmployeeMembershipResolution {
  activeOrgIds: string[];
  revoked?: boolean;
  auditAuthorized?: boolean;
}

export interface EmployeeTokenExchangeRequest {
  grant_type?: string;
  subject_token?: string;
  subject_token_type?: string;
  audience?: string;
  resource?: string;
  scope?: string;
  org_id?: string;
  orgId?: string;
}

export interface EmployeeTokenExchangeResponse {
  access_token: string;
  token_type: "Bearer";
  issued_token_type: typeof ACCESS_TOKEN_TYPE;
  expires_in: number;
  scope?: string;
}

export interface EmployeeTokenExchangeOptions {
  instanceId?: string;
  signingSecret?: string;
  allowedIssuers?: readonly string[];
  expectedIamAudience?: string | readonly string[];
  expectedTargetAudience?: string;
  expectedResourceRoot?: string;
  maxTtlSeconds?: number;
  resolveJwks?: (issuer: string, kid?: string) => Promise<readonly JsonWebKey[]>;
  resolveEmployeeMembership?: (input: {
    issuer: string;
    subject: string;
    requestedOrgId?: string;
  }) => Promise<EmployeeMembershipResolution>;
  isPrincipalRevoked?: (input: {
    issuer: string;
    subject: string;
    jti?: string;
  }) => Promise<boolean> | boolean;
  now?: () => number;
}

interface ParsedJwt {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
  signingInput: string;
  signatureB64: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function parseJwt(token: string): ParsedJwt | null {
  const trimmed = token.trim();
  const parts = trimmed.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, claimsB64, signatureB64] = parts;
  if (!headerB64 || !claimsB64 || !signatureB64) return null;
  try {
    const header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
    const claims = JSON.parse(Buffer.from(claimsB64, "base64url").toString("utf8"));
    if (!header || typeof header !== "object" || Array.isArray(header)) return null;
    if (!claims || typeof claims !== "object" || Array.isArray(claims)) return null;
    return {
      header: header as Record<string, unknown>,
      claims: claims as Record<string, unknown>,
      signingInput: `${headerB64}.${claimsB64}`,
      signatureB64,
    };
  } catch {
    return null;
  }
}

function deriveEmployeeTokenKey(masterSecret: string, instanceId: string, orgId: string): string {
  return createHmac("sha256", masterSecret)
    .update(`delegra:employee-token:${instanceId}:${orgId}`)
    .digest("hex");
}

function signHs256(key: string, signingInput: string): string {
  return createHmac("sha256", key).update(signingInput).digest("base64url");
}

function safeCompare(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function matchesAudience(
  audClaim: unknown,
  expected: string | readonly string[] | undefined,
): boolean {
  if (!expected) return true;
  const expectedList = Array.isArray(expected) ? expected : [expected];
  if (expectedList.length === 0) return true;
  if (typeof audClaim === "string") {
    return expectedList.includes(audClaim);
  }
  if (Array.isArray(audClaim)) {
    return audClaim.some((item) => typeof item === "string" && expectedList.includes(item));
  }
  return false;
}

function verifyAsymmetricSignature(
  alg: string,
  signingInput: string,
  signatureB64: string,
  jwk: JsonWebKey,
): boolean {
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey({ key: jwk, format: "jwk" });
  } catch {
    return false;
  }
  const data = Buffer.from(signingInput, "utf8");
  const signature = Buffer.from(signatureB64, "base64url");

  try {
    if (alg === "RS256") {
      if (publicKey.asymmetricKeyType !== "rsa") return false;
      return cryptoVerify("sha256", data, publicKey, signature);
    }
    if (alg === "ES256") {
      if (publicKey.asymmetricKeyType !== "ec") return false;
      return cryptoVerify(
        "sha256",
        data,
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        signature,
      );
    }
    if (alg === "EdDSA") {
      if (publicKey.asymmetricKeyType !== "ed25519" && publicKey.asymmetricKeyType !== "ed448") {
        return false;
      }
      return cryptoVerify(null, data, publicKey, signature);
    }
    return false;
  } catch {
    return false;
  }
}

function extractOrgIdFromScope(scope: string | undefined): string | null {
  if (!isNonEmptyString(scope)) return null;
  for (const token of scope.trim().split(/\s+/)) {
    if (token.startsWith("org:") && token.length > 4) {
      return token.slice(4);
    }
  }
  return null;
}

function normalizeResourceUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("/")) {
    return trimmed.replace(/\/+$/, "") || "/";
  }
  try {
    const parsed = new URL(trimmed);
    const cleanPath = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.origin}${cleanPath}`;
  } catch {
    return null;
  }
}

function resourceMatchesExpected(requestedResource: string, expectedResourceRoot: string): boolean {
  const normalizedReq = normalizeResourceUrl(requestedResource);
  const normalizedExpected = normalizeResourceUrl(expectedResourceRoot);
  if (!normalizedReq || !normalizedExpected) return false;

  if (normalizedExpected.startsWith("/")) {
    if (normalizedReq.startsWith("/")) {
      return normalizedReq === normalizedExpected || normalizedReq.startsWith(`${normalizedExpected}/`);
    }
    try {
      const reqPath = new URL(normalizedReq).pathname.replace(/\/+$/, "");
      return reqPath === normalizedExpected || reqPath.startsWith(`${normalizedExpected}/`);
    } catch {
      return false;
    }
  }
  return normalizedReq === normalizedExpected || normalizedReq.startsWith(`${normalizedExpected}/`);
}

function createEnvJwksResolver(env: NodeJS.ProcessEnv): ((issuer: string, kid?: string) => Promise<readonly JsonWebKey[]>) | undefined {
  const staticJson = env.DELEGRA_IAM_JWKS_JSON?.trim();
  if (staticJson) {
    let parsedKeys: JsonWebKey[] = [];
    try {
      const parsed = JSON.parse(staticJson) as { keys?: JsonWebKey[] } | JsonWebKey[];
      parsedKeys = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.keys) ? parsed.keys : [];
    } catch {
      parsedKeys = [];
    }
    return async () => parsedKeys;
  }

  const jwksUrl = env.DELEGRA_IAM_JWKS_URL?.trim();
  if (!jwksUrl) return undefined;

  let cachedKeys: JsonWebKey[] = [];
  let cachedAt = 0;

  return async (_issuer: string, kid?: string) => {
    const nowMs = Date.now();
    const hasKid = !kid || cachedKeys.some((k) => (k as Record<string, unknown>).kid === kid);
    if (cachedKeys.length > 0 && nowMs - cachedAt < DEFAULT_JWKS_CACHE_TTL_MS && hasKid) {
      return cachedKeys;
    }
    const response = await fetch(jwksUrl, {
      headers: { accept: "application/json" },
      signal: typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(5_000) : undefined,
    });
    if (!response.ok) {
      throw new EmployeeExpertsError("EXPERT_AUTH_INVALID", "Unable to fetch IAM JWKS.");
    }
    const payload = (await response.json()) as { keys?: JsonWebKey[] };
    if (!payload || !Array.isArray(payload.keys)) {
      throw new EmployeeExpertsError("EXPERT_AUTH_INVALID", "IAM JWKS payload is invalid.");
    }
    cachedKeys = payload.keys;
    cachedAt = nowMs;
    return cachedKeys;
  };
}

/**
 * Creates the RFC 8693 employee token exchange and production credential
 * verifier service implementing CORP-DSH-EXPERT-001 §2.1–§2.3 and §9.3.
 */
export function createEmployeeTokenExchangeService(options: EmployeeTokenExchangeOptions = {}) {
  const now = options.now ?? (() => Date.now());
  const instanceId = options.instanceId?.trim() || resolvePaperclipInstanceId();
  const signingSecret = options.signingSecret?.trim() || "";
  const allowedIssuers = new Set(
    (options.allowedIssuers ?? []).map((item) => item.trim()).filter(Boolean),
  );
  const expectedTargetAudience = options.expectedTargetAudience?.trim() || instanceId;
  const expectedResourceRoot = options.expectedResourceRoot?.trim() || "/api/v1/employee";
  const maxTtlSeconds = Math.max(
    1,
    Math.min(
      options.maxTtlSeconds ?? MAX_EXCHANGED_TOKEN_TTL_SECONDS,
      MAX_EXCHANGED_TOKEN_TTL_SECONDS,
    ),
  );

  function isConfigured(): boolean {
    return Boolean(signingSecret && allowedIssuers.size > 0 && options.resolveJwks);
  }

  async function verifyIamSubjectToken(subjectToken: string): Promise<{
    issuer: string;
    subject: string;
    exp: number;
    jti?: string;
    claimOrgId?: string;
  }> {
    if (!isConfigured() || !options.resolveJwks) {
      throw new EmployeeExpertsError(
        "EXPERT_AUTH_INVALID",
        "Employee token exchange is not configured on this instance.",
      );
    }

    const parsed = parseJwt(subjectToken);
    if (!parsed) {
      throw new EmployeeExpertsError("EXPERT_AUTH_INVALID", "IAM subject token is malformed.");
    }

    const alg = typeof parsed.header.alg === "string" ? parsed.header.alg : "";
    if (!ALLOWED_IAM_ALGS.has(alg)) {
      throw new EmployeeExpertsError("EXPERT_AUTH_INVALID", "IAM subject token algorithm is not allowed.");
    }

    const issuer = isNonEmptyString(parsed.claims.iss) ? parsed.claims.iss.trim() : "";
    if (!issuer || !allowedIssuers.has(issuer)) {
      throw new EmployeeExpertsError("EXPERT_AUTH_INVALID", "IAM token issuer is not trusted.");
    }

    if (!matchesAudience(parsed.claims.aud, options.expectedIamAudience)) {
      throw new EmployeeExpertsError("EXPERT_AUTH_INVALID", "IAM token audience is invalid.");
    }

    const subject = isNonEmptyString(parsed.claims.sub) ? parsed.claims.sub.trim() : "";
    if (!subject) {
      throw new EmployeeExpertsError("EXPERT_AUTH_INVALID", "IAM token subject is missing.");
    }

    const kid = isNonEmptyString(parsed.header.kid) ? parsed.header.kid.trim() : undefined;
    let keys: readonly JsonWebKey[];
    try {
      keys = await options.resolveJwks(issuer, kid);
    } catch (err) {
      if (err instanceof EmployeeExpertsError) throw err;
      throw new EmployeeExpertsError("EXPERT_AUTH_INVALID", "Unable to resolve IAM verification keys.");
    }

    const candidates = kid
      ? keys.filter((key) => (key as Record<string, unknown>).kid === kid)
      : keys;
    const verified = candidates.some((jwk) =>
      verifyAsymmetricSignature(alg, parsed.signingInput, parsed.signatureB64, jwk),
    );
    if (!verified) {
      throw new EmployeeExpertsError("EXPERT_AUTH_INVALID", "IAM subject token signature verification failed.");
    }

    const nowSec = Math.floor(now() / 1000);
    const exp = typeof parsed.claims.exp === "number" ? parsed.claims.exp : NaN;
    const nbf = typeof parsed.claims.nbf === "number" ? parsed.claims.nbf : undefined;
    if (!Number.isFinite(exp)) {
      throw new EmployeeExpertsError("EXPERT_AUTH_INVALID", "IAM subject token is missing exp claim.");
    }
    if (nbf !== undefined && nbf > nowSec + CLOCK_SKEW_SECONDS) {
      throw new EmployeeExpertsError("EXPERT_AUTH_INVALID", "IAM subject token is not yet valid.");
    }
    if (exp <= nowSec) {
      throw new EmployeeExpertsError("EXPERT_AUTH_REVOKED", "IAM subject token has expired.");
    }

    const jti = isNonEmptyString(parsed.claims.jti) ? parsed.claims.jti.trim() : undefined;
    if (options.isPrincipalRevoked && (await options.isPrincipalRevoked({ issuer, subject, jti }))) {
      throw new EmployeeExpertsError("EXPERT_AUTH_REVOKED", "IAM principal has been revoked or disabled.");
    }

    const claimOrgId = isNonEmptyString(parsed.claims.org_id)
      ? parsed.claims.org_id.trim()
      : isNonEmptyString(parsed.claims.company_id)
        ? parsed.claims.company_id.trim()
        : undefined;

    return { issuer, subject, exp, jti, claimOrgId };
  }

  async function exchangeToken(
    input: EmployeeTokenExchangeRequest,
  ): Promise<EmployeeTokenExchangeResponse> {
    if (input.grant_type !== TOKEN_EXCHANGE_GRANT_TYPE) {
      throw new EmployeeExpertsError(
        "EXPERT_REQUEST_INVALID",
        "grant_type must be urn:ietf:params:oauth:grant-type:token-exchange.",
      );
    }
    if (input.subject_token_type !== ACCESS_TOKEN_TYPE) {
      throw new EmployeeExpertsError(
        "EXPERT_REQUEST_INVALID",
        "subject_token_type must be urn:ietf:params:oauth:token-type:access_token.",
      );
    }
    if (!isNonEmptyString(input.subject_token)) {
      throw new EmployeeExpertsError("EXPERT_AUTH_INVALID", "subject_token is required.");
    }
    if (!isNonEmptyString(input.audience)) {
      throw new EmployeeExpertsError("EXPERT_REQUEST_INVALID", "audience is required.");
    }
    if (!isNonEmptyString(input.resource)) {
      throw new EmployeeExpertsError("EXPERT_REQUEST_INVALID", "resource is required.");
    }

    const requestedAudience = input.audience.trim();
    if (requestedAudience !== expectedTargetAudience) {
      throw new EmployeeExpertsError("EXPERT_AUTH_INVALID", "Requested audience does not match this Delegra instance.");
    }
    const requestedResource = input.resource.trim();
    if (!resourceMatchesExpected(requestedResource, expectedResourceRoot)) {
      throw new EmployeeExpertsError("EXPERT_SCOPE_MISMATCH", "Requested resource does not match the employee API root.");
    }

    const iam = await verifyIamSubjectToken(input.subject_token);

    const requestedOrgId =
      (isNonEmptyString(input.org_id) ? input.org_id.trim() : null) ??
      (isNonEmptyString(input.orgId) ? input.orgId.trim() : null) ??
      extractOrgIdFromScope(input.scope) ??
      iam.claimOrgId ??
      undefined;

    if (!options.resolveEmployeeMembership) {
      throw new EmployeeExpertsError(
        "EXPERT_ORG_FORBIDDEN",
        "Employee organization membership resolver is not configured.",
      );
    }

    const membership = await options.resolveEmployeeMembership({
      issuer: iam.issuer,
      subject: iam.subject,
      requestedOrgId,
    });
    if (membership.revoked === true) {
      throw new EmployeeExpertsError("EXPERT_AUTH_REVOKED", "Employee account has been revoked or disabled.");
    }

    const activeOrgIds = membership.activeOrgIds.filter(isNonEmptyString);
    const resolvedOrgId = requestedOrgId ?? (activeOrgIds.length === 1 ? activeOrgIds[0] : undefined);
    if (!resolvedOrgId || !activeOrgIds.includes(resolvedOrgId)) {
      throw new EmployeeExpertsError(
        "EXPERT_ORG_FORBIDDEN",
        "Employee does not hold active membership in the requested organization.",
      );
    }

    const nowSec = Math.floor(now() / 1000);
    const remainingIamTtlSec = Math.floor(iam.exp - nowSec);
    if (remainingIamTtlSec < 1) {
      throw new EmployeeExpertsError("EXPERT_AUTH_REVOKED", "IAM subject token has expired.");
    }
    // Hard §2.3 & REQ-01/02/03 bound: never exceed min(300, remaining IAM TTL).
    const expiresIn = Math.min(maxTtlSeconds, MAX_EXCHANGED_TOKEN_TTL_SECONDS, remainingIamTtlSec);
    const exp = nowSec + expiresIn;
    const jti = `emp_tok_${randomUUID()}`;
    const grantedScope = isNonEmptyString(input.scope)
      ? input.scope.trim()
      : `employee:experts org:${resolvedOrgId}`;

    const header = { alg: EXCHANGED_TOKEN_ALG, typ: "JWT" };
    const claims = {
      typ: EMPLOYEE_ACCESS_TOKEN_TYPE,
      iss: iam.issuer,
      sub: iam.subject,
      aud: expectedTargetAudience,
      resource: requestedResource,
      instance_id: instanceId,
      org_id: resolvedOrgId,
      scope: grantedScope,
      iat: nowSec,
      exp,
      jti,
    };
    const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claims))}`;
    const key = deriveEmployeeTokenKey(signingSecret, instanceId, resolvedOrgId);
    const signature = signHs256(key, signingInput);

    return {
      access_token: `${signingInput}.${signature}`,
      token_type: "Bearer",
      issued_token_type: ACCESS_TOKEN_TYPE,
      expires_in: expiresIn,
      scope: grantedScope,
    };
  }

  /**
   * Production verifyCredential callback for createEmployeeExpertsService.
   * Enforces CORP-DSH-EXPERT-001 §2.1 precedence:
   *   1) 401 EXPERT_AUTH_INVALID (signature, issuer, audience, instance)
   *   2) 401 EXPERT_AUTH_REVOKED (expiry, principal revocation)
   *   3) 403 EXPERT_ORG_FORBIDDEN (active org membership via activeOrgIds)
   *   4) 403 EXPERT_SCOPE_MISMATCH (orgId mismatch in employee-experts authenticate)
   */
  async function verifyCredential(bearerToken: string): Promise<EmployeeCredentialContext | null> {
    if (!signingSecret || allowedIssuers.size === 0) {
      return null;
    }

    const parsed = parseJwt(bearerToken);
    if (!parsed) {
      throw new EmployeeExpertsError("EXPERT_AUTH_INVALID", "Employee credential is malformed.");
    }

    if (parsed.header.alg !== EXCHANGED_TOKEN_ALG) {
      throw new EmployeeExpertsError("EXPERT_AUTH_INVALID", "Employee credential algorithm is invalid.");
    }

    const { claims } = parsed;
    if (claims.typ !== EMPLOYEE_ACCESS_TOKEN_TYPE) {
      throw new EmployeeExpertsError("EXPERT_AUTH_INVALID", "Employee credential type is invalid.");
    }

    const issuer = isNonEmptyString(claims.iss) ? claims.iss.trim() : "";
    const subject = isNonEmptyString(claims.sub) ? claims.sub.trim() : "";
    const orgId = isNonEmptyString(claims.org_id) ? claims.org_id.trim() : "";
    const tokenInstanceId = isNonEmptyString(claims.instance_id) ? claims.instance_id.trim() : "";
    const tokenAudience = isNonEmptyString(claims.aud) ? claims.aud.trim() : "";
    const iat = typeof claims.iat === "number" ? claims.iat : NaN;
    const exp = typeof claims.exp === "number" ? claims.exp : NaN;
    const jti = isNonEmptyString(claims.jti) ? claims.jti.trim() : undefined;

    if (
      !issuer ||
      !subject ||
      !orgId ||
      !allowedIssuers.has(issuer) ||
      tokenAudience !== expectedTargetAudience ||
      tokenInstanceId !== instanceId ||
      !Number.isFinite(iat) ||
      !Number.isFinite(exp)
    ) {
      throw new EmployeeExpertsError("EXPERT_AUTH_INVALID", "Employee credential claims are invalid.");
    }

    const key = deriveEmployeeTokenKey(signingSecret, instanceId, orgId);
    const expectedSig = signHs256(key, parsed.signingInput);
    if (!safeCompare(parsed.signatureB64, expectedSig)) {
      throw new EmployeeExpertsError("EXPERT_AUTH_INVALID", "Employee credential signature is invalid.");
    }

    const nowMs = now();
    const nowSec = Math.floor(nowMs / 1000);
    if (exp <= nowSec) {
      throw new EmployeeExpertsError("EXPERT_AUTH_REVOKED", "Employee credential has expired.");
    }

    if (options.isPrincipalRevoked && (await options.isPrincipalRevoked({ issuer, subject, jti }))) {
      throw new EmployeeExpertsError("EXPERT_AUTH_REVOKED", "Employee credential has been revoked.");
    }

    let activeOrgIds: string[] | undefined;
    let auditAuthorized = false;
    if (options.resolveEmployeeMembership) {
      const membership = await options.resolveEmployeeMembership({
        issuer,
        subject,
        requestedOrgId: orgId,
      });
      if (membership.revoked === true) {
        throw new EmployeeExpertsError("EXPERT_AUTH_REVOKED", "Employee account has been revoked.");
      }
      activeOrgIds = membership.activeOrgIds;
      auditAuthorized = membership.auditAuthorized === true;
    }

    return {
      instanceId,
      orgId,
      issuer,
      subject,
      verifiedAt: new Date(nowMs).toISOString(),
      validUntil: new Date(exp * 1000).toISOString(),
      ...(activeOrgIds !== undefined ? { activeOrgIds } : {}),
      ...(auditAuthorized ? { auditAuthorized: true } : {}),
    };
  }

  return {
    isConfigured,
    exchangeToken,
    verifyCredential,
    config: Object.freeze({
      endpointPath: EMPLOYEE_TOKEN_EXCHANGE_PATH,
      instanceId,
      expectedTargetAudience,
      expectedResourceRoot,
      maxTtlSeconds,
    }),
  };
}

export type EmployeeTokenExchangeService = ReturnType<typeof createEmployeeTokenExchangeService>;

/**
 * Resolves an enterprise IAM (issuer, subject) principal to active Delegra
 * company memberships using PostgreSQL authAccounts + companyMemberships.
 */
export function createDbEmployeeMembershipResolver(db: Db) {
  return async (input: {
    issuer: string;
    subject: string;
    requestedOrgId?: string;
  }): Promise<EmployeeMembershipResolution> => {
    const accountRows = await db
      .select({ userId: authAccounts.userId })
      .from(authAccounts)
      .where(
        and(
          eq(authAccounts.issuer, input.issuer),
          eq(authAccounts.accountId, input.subject),
        ),
      )
      .limit(1);

    const principalId = accountRows[0]?.userId ?? input.subject;
    const memberships = await db
      .select({
        companyId: companyMemberships.companyId,
        membershipRole: companyMemberships.membershipRole,
      })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, principalId),
          eq(companyMemberships.status, "active"),
        ),
      );

    const activeOrgIds = memberships.map((row) => row.companyId);
    const auditAuthorized = memberships.some(
      (row) => row.membershipRole === "owner" || row.membershipRole === "audit",
    );
    return { activeOrgIds, auditAuthorized };
  };
}

export function createProductionEmployeeTokenExchangeService(
  db: Db,
  opts?: { instanceId?: string; env?: NodeJS.ProcessEnv },
): EmployeeTokenExchangeService {
  const env = opts?.env ?? process.env;
  const instanceId = opts?.instanceId?.trim() || resolvePaperclipInstanceId();
  const allowedIssuers = (env.DELEGRA_IAM_ALLOWED_ISSUERS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const expectedIamAudience = (env.DELEGRA_IAM_EXPECTED_AUDIENCE ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const signingSecret =
    env.DELEGRA_EMPLOYEE_TOKEN_SECRET?.trim() ||
    env.PAPERCLIP_AGENT_JWT_SECRET?.trim() ||
    env.BETTER_AUTH_SECRET?.trim() ||
    "";
  const revokedSubjects = new Set(
    (env.DELEGRA_IAM_REVOKED_SUBJECTS ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );

  return createEmployeeTokenExchangeService({
    instanceId,
    signingSecret,
    allowedIssuers,
    expectedIamAudience: expectedIamAudience.length > 0 ? expectedIamAudience : undefined,
    expectedTargetAudience: env.DELEGRA_EMPLOYEE_TOKEN_AUDIENCE?.trim() || instanceId,
    expectedResourceRoot: env.DELEGRA_EMPLOYEE_TOKEN_RESOURCE?.trim() || "/api/v1/employee",
    resolveJwks: createEnvJwksResolver(env),
    resolveEmployeeMembership: createDbEmployeeMembershipResolver(db),
    isPrincipalRevoked: ({ issuer, subject }) =>
      revokedSubjects.has(subject) || revokedSubjects.has(`${issuer}|${subject}`),
  });
}

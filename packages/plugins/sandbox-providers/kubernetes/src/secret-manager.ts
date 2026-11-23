import type { KubeClients } from "./kube-client.js";

export interface CreatePerRunSecretInput {
  namespace: string;
  secretName: string;
  runId: string;
  ownerKind: string;
  ownerApiVersion: string;
  ownerName: string;
  ownerUid: string;
  bootstrapToken: string;
  adapterEnv: Record<string, string>;
}

export interface CreateAgentSessionSecretInput {
  namespace: string;
  secretName: string;
  runId: string;
  runGeneration: number;
  ownerKind: string;
  ownerApiVersion: string;
  ownerName: string;
  ownerUid: string;
  bootstrapToken: string;
  gatewayProxyUrl: string;
  /**
   * Optional one-time proxy session token. When delivered via atomic tmpfs
   * file (`/run/delegra-auth/lease-token`), omit this so even the session
   * token is absent from `envFrom`.
   */
  proxySessionToken?: string;
  /** Non-sensitive runtime parameters only (strictly validated against credential keys). */
  runtimeEnv?: Record<string, string>;
}

export interface CreateProxyAuthSecretInput {
  namespace: string;
  secretName: string;
  runId: string;
  ownerKind: string;
  ownerApiVersion: string;
  ownerName: string;
  ownerUid: string;
  controlPlaneUrl: string;
  internalAuthToken: string;
}

const FORBIDDEN_AGENT_CREDENTIAL_KEY_PATTERNS: readonly RegExp[] = [
  /^ANTHROPIC_API_KEY$/i,
  /^OPENAI_API_KEY$/i,
  /^GOOGLE_API_KEY$/i,
  /^GEMINI_API_KEY$/i,
  /^OPENROUTER_API_KEY$/i,
  /^AWS_ACCESS_KEY_ID$/i,
  /^AWS_SECRET_ACCESS_KEY$/i,
  /^AWS_SESSION_TOKEN$/i,
  /_API_KEY$/i,
  /_ACCESS_TOKEN$/i,
  /_SECRET_KEY$/i,
];

/**
 * Fail-closed guard guaranteeing that no user model API key or cloud IAM
 * credential ever enters an expert agent container's Secret / `envFrom`.
 */
export function assertNoUserCredentialsInEnv(env: Record<string, string>): void {
  for (const key of Object.keys(env)) {
    if (FORBIDDEN_AGENT_CREDENTIAL_KEY_PATTERNS.some((re) => re.test(key))) {
      throw new Error(
        `Refusing to inject credential key "${key}" into agent session Secret: ` +
          `expert sandboxes must authenticate exclusively through delegra-gateway-proxy.`,
      );
    }
  }
}

export async function createPerRunSecret(clients: KubeClients, input: CreatePerRunSecretInput): Promise<void> {
  if (!input.ownerUid) {
    throw new Error("createPerRunSecret requires a non-empty ownerUid");
  }
  if ("BOOTSTRAP_TOKEN" in input.adapterEnv) {
    throw new Error("adapterEnv must not contain BOOTSTRAP_TOKEN (reserved key)");
  }
  await clients.core.createNamespacedSecret({
    namespace: input.namespace,
    body: {
      apiVersion: "v1",
      kind: "Secret",
      type: "Opaque",
      metadata: {
        name: input.secretName,
        namespace: input.namespace,
        labels: {
          "paperclip.io/run-id": input.runId,
          "paperclip.io/managed-by": "paperclip-k8s-plugin",
        },
        ownerReferences: [
          {
            apiVersion: input.ownerApiVersion,
            kind: input.ownerKind,
            name: input.ownerName,
            uid: input.ownerUid,
            controller: true,
            blockOwnerDeletion: true,
          },
        ],
      },
      stringData: {
        BOOTSTRAP_TOKEN: input.bootstrapToken,
        ...input.adapterEnv,
      },
    },
  });
}

/**
 * Creates a zero-user-credential per-run Secret for an expert agent container.
 * Contains only the bootstrap token, run generation metadata, gateway proxy URL,
 * optional one-time proxy session token, and strictly validated non-sensitive env.
 */
export async function createAgentSessionSecret(
  clients: KubeClients,
  input: CreateAgentSessionSecretInput,
): Promise<void> {
  if (!input.ownerUid) {
    throw new Error("createAgentSessionSecret requires a non-empty ownerUid");
  }
  if (!Number.isInteger(input.runGeneration) || input.runGeneration < 1) {
    throw new Error("createAgentSessionSecret requires a positive integer runGeneration");
  }
  const runtimeEnv = input.runtimeEnv ?? {};
  if ("BOOTSTRAP_TOKEN" in runtimeEnv || "PROXY_SESSION_TOKEN" in runtimeEnv) {
    throw new Error("runtimeEnv must not contain BOOTSTRAP_TOKEN or PROXY_SESSION_TOKEN");
  }
  assertNoUserCredentialsInEnv(runtimeEnv);

  const stringData: Record<string, string> = {
    ...runtimeEnv,
    BOOTSTRAP_TOKEN: input.bootstrapToken,
    DELEGRA_GATEWAY_PROXY_URL: input.gatewayProxyUrl,
    PAPERCLIP_RUN_ID: input.runId,
    PAPERCLIP_RUN_GENERATION: String(input.runGeneration),
    ...(input.proxySessionToken ? { PROXY_SESSION_TOKEN: input.proxySessionToken } : {}),
  };

  await clients.core.createNamespacedSecret({
    namespace: input.namespace,
    body: {
      apiVersion: "v1",
      kind: "Secret",
      type: "Opaque",
      metadata: {
        name: input.secretName,
        namespace: input.namespace,
        labels: {
          "paperclip.io/run-id": input.runId,
          "paperclip.io/secret-scope": "agent-session",
          "paperclip.io/managed-by": "paperclip-k8s-plugin",
        },
        ownerReferences: [
          {
            apiVersion: input.ownerApiVersion,
            kind: input.ownerKind,
            name: input.ownerName,
            uid: input.ownerUid,
            controller: true,
            blockOwnerDeletion: true,
          },
        ],
      },
      stringData,
    },
  });
}

/**
 * Creates a dedicated control-plane callback Secret (`pc-<ulid>-proxy-env`)
 * containing only internal proxy-to-control-plane authentication credentials.
 */
export async function createProxyAuthSecret(
  clients: KubeClients,
  input: CreateProxyAuthSecretInput,
): Promise<void> {
  if (!input.ownerUid) {
    throw new Error("createProxyAuthSecret requires a non-empty ownerUid");
  }
  if (!input.internalAuthToken || input.internalAuthToken.trim().length === 0) {
    throw new Error("createProxyAuthSecret requires a non-empty internalAuthToken");
  }
  await clients.core.createNamespacedSecret({
    namespace: input.namespace,
    body: {
      apiVersion: "v1",
      kind: "Secret",
      type: "Opaque",
      metadata: {
        name: input.secretName,
        namespace: input.namespace,
        labels: {
          "paperclip.io/run-id": input.runId,
          "paperclip.io/secret-scope": "proxy-auth",
          "paperclip.io/managed-by": "paperclip-k8s-plugin",
        },
        ownerReferences: [
          {
            apiVersion: input.ownerApiVersion,
            kind: input.ownerKind,
            name: input.ownerName,
            uid: input.ownerUid,
            controller: true,
            blockOwnerDeletion: true,
          },
        ],
      },
      stringData: {
        DELEGRA_CONTROL_PLANE_URL: input.controlPlaneUrl,
        DELEGRA_GATEWAY_INTERNAL_TOKEN: input.internalAuthToken,
      },
    },
  });
}

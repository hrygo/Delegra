/** Codex-owned, secret-free launch intent. Paths are values for cross-language receipt parity. */
export interface CodexFilesystemEntry {
  path: string;
  access: "none" | "read" | "write";
}

export interface CodexLaunchPolicy {
  schema: "paperclip.codex.launch-policy.v1";
  defaultFilesystem: CodexFilesystemEntry[];
  planningFilesystem: CodexFilesystemEntry[];
  networkAccess: boolean;
  externallySandboxed: boolean;
  shellEnvironmentPolicy: {
    inherit: "all" | "none";
    ignoreDefaultExcludes: boolean;
    includeOnly: string[];
    set: Record<string, string>;
  };
}

export interface FrozenCodexLaunchContext {
  schema: "paperclip.codex.frozen-launch.v1";
  policy: CodexLaunchPolicy;
  collaborationMode: "default" | "plan";
  homeMode: "managed" | "preconfigured";
  workingDirectory: string;
  includeSkillInstructions: boolean;
  includeCollaborationModeInstructions: boolean;
  threadId: string;
  providerSessionId: string | null;
  providerRecoveryPolicy: "same_session_only";
}

export interface CodexLaunchPolicyIdentity {
  kind: "codex_launch_policy_v1";
  digest: string;
}

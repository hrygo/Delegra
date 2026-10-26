import fs from "node:fs/promises";
import path from "node:path";

type Log = (stream: "stdout" | "stderr", message: string) => Promise<void>;
type Identity = { directory: string; dev: number; ino: number };
export type ClaudeTaskCacheCleanup = "removed" | "retained" | "failed";
export interface ClaudeTaskBuildCache {
  root: string;
  envOverrides: Readonly<Record<string, string>>;
  beginInvocation(): () => void;
  cleanup(input: { collectionSucceeded: boolean; onLog?: Log }): Promise<ClaudeTaskCacheCleanup>;
}

function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Adapter-owned writable state inside the existing cwd sandbox. No additional
 * write grant, caller path, provider HOME, or authentication state is involved.
 */
export async function prepareClaudeTaskBuildCache(input: {
  cwd: string;
  protectedWriteRoots: readonly string[];
  onLog?: Log;
}): Promise<ClaudeTaskBuildCache> {
  const cwd = await fs.realpath(input.cwd);
  const parent = path.join(cwd, ".paperclip-runtime", "claude", "task-cache");
  if (input.protectedWriteRoots.some(protectedRoot => !path.isAbsolute(protectedRoot)
    || contains(protectedRoot, parent) || contains(parent, protectedRoot))) {
    throw new Error("Claude task cache intersects protected write paths");
  }
  const identities: Identity[] = [];
  const record = async (directory: string) => {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe Claude task cache ancestor");
    identities.push({ directory, dev: stat.dev, ino: stat.ino });
  };
  const unchanged = async () => {
    for (const identity of identities) {
      const stat = await fs.lstat(identity.directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== identity.dev || stat.ino !== identity.ino) return false;
    }
    return true;
  };
  await record(cwd);
  for (const directory of [path.join(cwd, ".paperclip-runtime"), path.join(cwd, ".paperclip-runtime", "claude"), parent]) {
    await fs.mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    await record(directory);
  }
  if (!await unchanged()) throw new Error("Claude task cache ancestry changed during preparation");
  const root = await fs.mkdtemp(path.join(parent, "task-"));
  try {
    await record(root);
    await fs.chmod(root, 0o700);
    if (!await unchanged()) throw new Error("changed root");
  } catch {
    await Promise.resolve().then(() => input.onLog?.("stderr", "[paperclip] Claude task cache retained: preparation identity is unconfirmed.\n")).catch(() => undefined);
    throw new Error("Claude task cache could not be prepared safely");
  }
  let invocation = 0;
  let stopped = false;
  const log = async (result: ClaudeTaskCacheCleanup, onLog?: Log) => {
    const message = result === "removed" ? "Claude task cache cleanup completed."
      : result === "retained" ? "Claude task cache retained: stop, collection or filesystem identity is unconfirmed."
      : "Claude task cache cleanup failed; remaining state retained.";
    await Promise.resolve().then(() => onLog?.(result === "removed" ? "stdout" : "stderr", `[paperclip] ${message}\n`)).catch(() => undefined);
    return result;
  };
  const cleanup: ClaudeTaskBuildCache["cleanup"] = async ({ collectionSucceeded, onLog }) => {
    if (invocation > 0 && (!stopped || !collectionSucceeded)) return log("retained", onLog);
    try {
      if (!await unchanged()) return log("retained", onLog);
      // A recursive rm does not follow descendant symlinks. Only this freshly
      // allocated exact root is owned; shared ancestors and siblings stay put.
      await fs.rm(root, { recursive: true });
      return log("removed", onLog);
    } catch {
      return log("failed", onLog);
    }
  };
  try {
    const cache = path.join(root, "cache");
    const store = path.join(cache, "pnpm-store");
    const uv = path.join(cache, "uv");
    const temporary = path.join(root, "tmp");
    const runtime = path.join(root, "runtime");
    for (const directory of [cache, store, uv, temporary, runtime]) {
      if (!await unchanged()) throw new Error("Claude task cache ancestry changed during preparation");
      await fs.mkdir(directory, { mode: 0o700 });
      await record(directory);
    }
    return {
      root,
      envOverrides: { pnpm_config_store_dir: store, PNPM_CONFIG_STORE_DIR: store, UV_CACHE_DIR: uv, TMPDIR: temporary, TMP: temporary, TEMP: temporary, XDG_RUNTIME_DIR: runtime },
      beginInvocation() {
        const generation = ++invocation;
        stopped = false;
        return () => { if (generation === invocation) stopped = true; };
      },
      cleanup,
    };
  } catch {
    await cleanup({ collectionSucceeded: true, onLog: input.onLog });
    throw new Error("Claude task cache could not be prepared safely");
  }
}

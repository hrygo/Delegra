import path from "node:path";

/** Pure target-side projection. Provider/auth values and explicit PATH retain
 * their original values; only process identity and writable tool state move.
 */
export function buildManagedRemoteEnvironment(input: {
  managed: boolean;
  remote: boolean;
  cwd: string;
  runId: string;
  env: Record<string, string>;
}): { env: Record<string, string>; prepareCommand: string | null; cleanupCommand: string | null } {
  if (!input.managed || !input.remote) return { env: { ...input.env }, prepareCommand: null, cleanupCommand: null };
  const cwd = input.cwd.replace(/\/+$/, "");
  if (!path.posix.isAbsolute(cwd) || path.posix.normalize(cwd) !== cwd || /[\x00\r\n\\]/.test(cwd)
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.runId)) {
    throw new Error("Invalid managed remote environment run root");
  }
  const root = path.posix.join(cwd, ".paperclip-runtime", "codex", "run-environment", input.runId);
  const home = path.posix.join(root, "home");
  const cache = path.posix.join(home, "cache");
  const data = path.posix.join(home, "data");
  const temporary = path.posix.join(root, "tmp");
  const projected = {
    HOME: home,
    XDG_CONFIG_HOME: path.posix.join(home, "config"),
    XDG_DATA_HOME: data,
    XDG_CACHE_HOME: cache,
    XDG_STATE_HOME: path.posix.join(home, "state"),
    XDG_RUNTIME_DIR: path.posix.join(root, "runtime"),
    TMPDIR: temporary, TMP: temporary, TEMP: temporary,
    UV_CACHE_DIR: path.posix.join(cache, "uv"),
    COREPACK_HOME: path.posix.join(cache, "corepack"),
    PNPM_HOME: path.posix.join(data, "pnpm"),
  };
  const directories = [...new Set([root, ...Object.values(projected)])];
  const quote = (directory: string) => `'${directory.replace(/'/g, `'"'"'`)}'`;
  const quoted = directories.map(quote).join(" ");
  const parents = [".paperclip-runtime", ".paperclip-runtime/codex", ".paperclip-runtime/codex/run-environment"].map(relative => path.posix.join(cwd, relative));
  const guarded = [...new Set([cwd, ...parents, ...directories])].sort((left, right) => left.split("/").length - right.split("/").length).map(quote).join(" ");
  return {
    env: { ...input.env, ...projected },
    // No credentials or arbitrary environment are passed to the preparation
    // shell. A failed mkdir/chmod must stop launch, rather than use host HOME.
    // rm does not follow links inside this owned root; guard its ancestry again
    // because a provider may have replaced a parent since preparation.
    cleanupCommand: `set -e; for directory in ${[cwd, ...parents, root].map(quote).join(" ")}; do [ ! -L "$directory" ] || exit 1; done; rm -rf -- ${quote(root)}`,
    prepareCommand: `set -e; umask 077; for directory in ${guarded}; do [ ! -L "$directory" ] || exit 1; if [ ! -d "$directory" ]; then mkdir "$directory"; fi; done; chmod 700 ${quoted}`,
  };
}

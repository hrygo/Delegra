import type { StorageService } from "../../storage/types.js";

/** Bound storage setup and streaming; destroy a stream returned after cancellation. */
export async function readApiArtifactBytes(storage: StorageService, companyId: string, objectKey: string, maxBytes: number, signal: AbortSignal, timeoutMs = 10_000): Promise<Buffer> {
  let expired = false;
  let stream: Awaited<ReturnType<StorageService["getObject"]>>["stream"] | undefined;
  let rejectStop!: (error: Error) => void;
  const stopped = new Promise<never>((_, reject) => { rejectStop = reject; });
  const stop = () => {
    if (expired) return;
    expired = true;
    stream?.destroy();
    rejectStop(new Error("runner_api_artifact_read_aborted_or_timed_out"));
  };
  const timer = setTimeout(stop, timeoutMs);
  timer.unref?.();
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  try {
    if (expired) return await stopped;
    const object = await Promise.race([storage.getObject(companyId, objectKey).then(result => {
      if (expired) result.stream.destroy();
      return result;
    }), stopped]);
    stream = object.stream;
    if (expired) throw new Error("runner_api_artifact_read_aborted_or_timed_out");
    const read = (async () => {
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of object.stream) {
        const bytes = Buffer.from(chunk);
        length += bytes.length;
        if (length > maxBytes) throw new Error("runner_api_artifact_read_size_limit");
        chunks.push(bytes);
      }
      return Buffer.concat(chunks);
    })();
    return await Promise.race([read, stopped]);
  } finally {
    expired = true;
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
    stream?.destroy();
  }
}

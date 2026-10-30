import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { StorageService, GetObjectResult } from "../../storage/types.js";
import { MAX_PENDING_ARTIFACT_STORAGE_OPENS, readApiArtifactBytes } from "./runner-api-artifact-read.js";
import { RUNNER_API_MAX_BYTES } from "./runner-api-client.js";

describe("bounded API artifact storage reads", () => {
  it("limits underlying opens even after all callers time out and releases permits only on settlement", async () => {
    const resolvers: ((value: GetObjectResult) => void)[] = [];
    const storage = { getObject: vi.fn(() => new Promise<GetObjectResult>(resolve => resolvers.push(resolve))) } as unknown as StorageService;
    const attempts = Array.from({ length: MAX_PENDING_ARTIFACT_STORAGE_OPENS }, () =>
      readApiArtifactBytes(storage, "company", "key", 100, new AbortController().signal, 20));
    const results = await Promise.allSettled(attempts);
    expect(results.every(result => result.status === "rejected")).toBe(true);
    await expect(readApiArtifactBytes(storage, "company", "key", 100, new AbortController().signal)).rejects.toThrow("storage_busy");
    expect(storage.getObject).toHaveBeenCalledTimes(MAX_PENDING_ARTIFACT_STORAGE_OPENS);
    const late = resolvers.map(resolve => { const stream = new Readable({ read() {} }); resolve({ stream }); return stream; });
    await vi.waitFor(() => expect(late.every(stream => stream.destroyed)).toBe(true));
    const healthy = { getObject: vi.fn(async () => ({ stream: Readable.from(["ok"]) })) } as unknown as StorageService;
    await expect(readApiArtifactBytes(healthy, "company", "key", 100, new AbortController().signal)).resolves.toEqual(Buffer.from("ok"));
  });
  it("aborts a pending getObject and destroys a late stream", async () => {
    let resolve!: (value: GetObjectResult) => void;
    const storage = { getObject: vi.fn(() => new Promise<GetObjectResult>(r => { resolve = r; })) } as unknown as StorageService;
    const controller = new AbortController();
    const result = readApiArtifactBytes(storage, "company", "key", 100, controller.signal);
    controller.abort();
    await expect(result).rejects.toThrow("aborted_or_timed_out");
    const late = new Readable({ read() {} });
    resolve({ stream: late });
    await vi.waitFor(() => expect(late.destroyed).toBe(true));
  });

  it("times out a stalled stream and destroys it", async () => {
    const stream = new Readable({ read() {} });
    const storage = { getObject: vi.fn(async () => ({ stream })) } as unknown as StorageService;
    await expect(readApiArtifactBytes(storage, "company", "key", 100, new AbortController().signal, 20)).rejects.toThrow("aborted_or_timed_out");
    expect(stream.destroyed).toBe(true);
  });
  it("times out a pending getObject and destroys its late stream", async () => {
    let resolve!: (value: GetObjectResult) => void;
    const storage = { getObject: vi.fn(() => new Promise<GetObjectResult>(r => { resolve = r; })) } as unknown as StorageService;
    await expect(readApiArtifactBytes(storage, "company", "key", 100, new AbortController().signal, 20)).rejects.toThrow("aborted_or_timed_out");
    const late = new Readable({ read() {} });
    resolve({ stream: late });
    await vi.waitFor(() => expect(late.destroyed).toBe(true));
  });

  it("rejects and destroys a stream that exceeds the 10 MiB transfer limit", async () => {
    const stream = Readable.from([Buffer.alloc(RUNNER_API_MAX_BYTES), Buffer.from([1])]);
    const storage = { getObject: vi.fn(async () => ({ stream })) } as unknown as StorageService;
    await expect(readApiArtifactBytes(storage, "company", "key", RUNNER_API_MAX_BYTES, new AbortController().signal)).rejects.toThrow("size_limit");
    expect(stream.destroyed).toBe(true);
  });
});

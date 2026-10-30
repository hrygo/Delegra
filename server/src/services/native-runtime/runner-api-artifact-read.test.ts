import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { StorageService, GetObjectResult } from "../../storage/types.js";
import { readApiArtifactBytes } from "./runner-api-artifact-read.js";
import { RUNNER_API_MAX_BYTES } from "./runner-api-client.js";

describe("bounded API artifact storage reads", () => {
  it("limits underlying opens even after all callers time out and releases permits only on settlement", async () => {
    const resolvers: ((value: GetObjectResult) => void)[] = [];
    const storage = { getObject: vi.fn(() => new Promise<GetObjectResult>(resolve => resolvers.push(resolve))) } as unknown as StorageService;
    const attempts = Array.from({ length: 8 }, () =>
      readApiArtifactBytes(storage, "company", "key", 100, new AbortController().signal, 20));
    const results = await Promise.allSettled(attempts);
    expect(results.every(result => result.status === "rejected")).toBe(true);
    await expect(readApiArtifactBytes(storage, "company", "key", 100, new AbortController().signal)).rejects.toThrow("storage_busy");
    expect(storage.getObject).toHaveBeenCalledTimes(8);
    const late = resolvers.map(resolve => { const stream = new Readable({ read() {} }); resolve({ stream }); return stream; });
    await vi.waitFor(() => expect(late.every(stream => stream.destroyed)).toBe(true));
    const healthy = { getObject: vi.fn(async () => ({ stream: Readable.from(["ok"]) })) } as unknown as StorageService;
    await expect(readApiArtifactBytes(healthy, "company", "key", 100, new AbortController().signal)).resolves.toEqual(Buffer.from("ok"));
  });
  it.each(["synchronous throw", "asynchronous rejection"])("releases permits after a %s", async kind => {
    const failure = { getObject: vi.fn(() => {
      if (kind === "synchronous throw") throw new Error("open failed");
      return Promise.reject(new Error("open failed"));
    }) } as unknown as StorageService;
    for (let i = 0; i < 9; i++) {
      await expect(readApiArtifactBytes(failure, "company", "key", 100, new AbortController().signal)).rejects.toThrow("open failed");
    }
    expect(failure.getObject).toHaveBeenCalledTimes(9);
    const resolvers: ((value: GetObjectResult) => void)[] = [];
    const pending = { getObject: vi.fn(() => new Promise<GetObjectResult>(resolve => resolvers.push(resolve))) } as unknown as StorageService;
    const controllers = Array.from({ length: 8 }, () => new AbortController());
    const attempts = controllers.map(controller => readApiArtifactBytes(pending, "company", "key", 100, controller.signal));
    await expect(readApiArtifactBytes(pending, "company", "key", 100, new AbortController().signal)).rejects.toThrow("storage_busy");
    expect(pending.getObject).toHaveBeenCalledTimes(8);
    controllers.forEach(controller => controller.abort());
    await Promise.allSettled(attempts);
    const streams = resolvers.map(resolve => { const stream = new Readable({ read() {} }); resolve({ stream }); return stream; });
    await vi.waitFor(() => expect(streams.every(stream => stream.destroyed)).toBe(true));
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

  it("releases a timed-out open only after its late rejection", async () => {
    const rejectors: ((error: Error) => void)[] = [];
    const storage = { getObject: vi.fn(() => new Promise<GetObjectResult>((_, reject) => rejectors.push(reject))) } as unknown as StorageService;
    const attempts = Array.from({ length: 8 }, () => readApiArtifactBytes(storage, "company", "key", 100, new AbortController().signal, 20));
    const outcomes = await Promise.allSettled(attempts);
    expect(outcomes.every(result => result.status === "rejected" && String(result.reason).includes("aborted_or_timed_out"))).toBe(true);
    await expect(readApiArtifactBytes(storage, "company", "key", 100, new AbortController().signal)).rejects.toThrow("storage_busy");
    rejectors.forEach(reject => reject(new Error("late storage failure")));
    const healthy = { getObject: vi.fn(async () => ({ stream: Readable.from(["ok"]) })) } as unknown as StorageService;
    await vi.waitFor(async () => {
      await expect(readApiArtifactBytes(healthy, "company", "key", 100, new AbortController().signal)).resolves.toEqual(Buffer.from("ok"));
    });
  });

  it("rejects and destroys a stream that exceeds the 10 MiB transfer limit", async () => {
    const stream = Readable.from([Buffer.alloc(RUNNER_API_MAX_BYTES), Buffer.from([1])]);
    const storage = { getObject: vi.fn(async () => ({ stream })) } as unknown as StorageService;
    await expect(readApiArtifactBytes(storage, "company", "key", RUNNER_API_MAX_BYTES, new AbortController().signal)).rejects.toThrow("size_limit");
    expect(stream.destroyed).toBe(true);
  });
});

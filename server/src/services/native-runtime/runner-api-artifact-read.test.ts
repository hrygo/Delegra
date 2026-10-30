import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { StorageService, GetObjectResult } from "../../storage/types.js";
import { readApiArtifactBytes } from "./runner-api-artifact-read.js";
import { RUNNER_API_MAX_BYTES } from "./runner-api-client.js";

describe("bounded API artifact storage reads", () => {
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

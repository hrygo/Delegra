import { createServer, type Server } from "node:http";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createDelegraGatewayProxy,
  createLongLivedUpstreamFetch,
  createSseAuditAccumulator,
  INTERNAL_REVOCATIONS_PATH,
  type DelegraGatewayProxyHandle,
  type ProxyAccessLogEntry,
} from "../../src/gateway-proxy.js";
import {
  buildAtomicLeaseTokenWriteCommand,
  deliverLeaseTokenViaStdin,
  DEFAULT_LEASE_TOKEN_PATH,
} from "../../src/pod-exec.js";

describe("createDelegraGatewayProxy", () => {
  const handles: DelegraGatewayProxyHandle[] = [];
  const servers: Server[] = [];

  afterEach(async () => {
    while (handles.length > 0) {
      const handle = handles.pop();
      if (handle) await handle.close();
    }
    while (servers.length > 0) {
      const srv = servers.pop();
      if (srv) {
        await new Promise<void>((resolve, reject) =>
          srv.close((err) => (err ? reject(err) : resolve())),
        );
      }
    }
  });

  async function startProxy(
    options: Parameters<typeof createDelegraGatewayProxy>[0],
  ): Promise<{ baseUrl: string; handle: DelegraGatewayProxyHandle }> {
    const handle = createDelegraGatewayProxy(options);
    handles.push(handle);
    const { port, host } = await handle.listen(0);
    return { baseUrl: `http://${host}:${port}`, handle };
  }

  it("responds 200 on /healthz and /readyz and rejects non-allowlisted paths/methods", async () => {
    const authorize = vi.fn();
    const { baseUrl } = await startProxy({
      upstreamGatewayUrl: "https://ai-gateway.internal",
      authorize,
    });

    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/readyz`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/v1/chat/completions`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`${baseUrl}/v1/responses`, { method: "GET" })).status).toBe(405);
    expect(authorize).not.toHaveBeenCalled();
  });

  it("rejects requests missing Bearer token or run headers with 401 and zero upstream calls", async () => {
    const authorize = vi.fn();
    const fetchImpl = vi.fn();
    const { baseUrl } = await startProxy({
      upstreamGatewayUrl: "https://ai-gateway.internal",
      authorize,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const res = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.4" }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("USER_AUTH_REVOKED");
    expect(authorize).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("enforces maxBodyBytes cap with 413 PAYLOAD_TOO_LARGE", async () => {
    const authorize = vi.fn();
    const { baseUrl } = await startProxy({
      upstreamGatewayUrl: "https://ai-gateway.internal",
      authorize,
      maxBodyBytes: 64,
    });

    const res = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer sess-tok",
        "X-Paperclip-Run-Id": "run-1",
        "X-Paperclip-Run-Generation": "1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-5.4", input: "x".repeat(200) }),
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(authorize).not.toHaveBeenCalled();
  });

  it("blocks denied runs with zero upstream gateway traffic and caches cancellation", async () => {
    const authorize = vi.fn(async () => ({
      decision: "deny" as const,
      status: 403,
      code: "TASK_CANCELLED",
      message: "Run cancelled.",
      retryable: false as const,
    }));
    const fetchImpl = vi.fn();
    const { baseUrl } = await startProxy({
      upstreamGatewayUrl: "https://ai-gateway.internal",
      authorize,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const headers = {
      Authorization: "Bearer sess-tok",
      "X-Paperclip-Run-Id": "run-cancel",
      "X-Paperclip-Run-Generation": "1",
      "Content-Type": "application/json",
    };
    const res1 = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "gpt-5.4" }),
    });
    expect(res1.status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(authorize).toHaveBeenCalledOnce();

    // Subsequent call for the same cancelled run is short-circuited locally.
    const res2 = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "gpt-5.4" }),
    });
    expect(res2.status).toBe(403);
    expect(authorize).toHaveBeenCalledOnce();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("streams SSE responses, extracts zero-body usage audit, scrubs credentials, and logs without secrets", async () => {
    const upstreamHeaders = { Authorization: "Bearer ephemeral-secret-key" };
    const seenAuthHeaders: string[] = [];
    const logs: ProxyAccessLogEntry[] = [];

    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const hdrs = init?.headers as Record<string, string>;
      seenAuthHeaders.push(hdrs.Authorization);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: {\"type\":\"response.output_text.delta\",\"delta\":\"SENTINEL_SECRET_TEXT\"}\n\n"));
          controller.enqueue(
            new TextEncoder().encode(
              "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_99\",\"usage\":{\"input_tokens\":12,\"output_tokens\":34,\"total_tokens\":46}}}\n\n",
            ),
          );
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "X-Gateway-Request-Id": "gw-req-42",
        },
      });
    });

    const { baseUrl } = await startProxy({
      upstreamGatewayUrl: "https://ai-gateway.internal",
      authorize: async () => ({
        decision: "allow",
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        upstream: { headers: upstreamHeaders },
      }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sseHeartbeatIntervalMs: 0,
      onAccessLog: (entry) => logs.push(entry),
    });

    const res = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer sess-tok",
        "X-Paperclip-Run-Id": "run-ok",
        "X-Paperclip-Run-Generation": "2",
        "X-Client-Request-Id": "client-req-1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-5.4", stream: true }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-gateway-request-id")).toBe("gw-req-42");
    const text = await res.text();
    expect(text).toContain("SENTINEL_SECRET_TEXT");
    expect(seenAuthHeaders).toEqual(["Bearer ephemeral-secret-key"]);

    // Ephemeral upstream credential map must be scrubbed in place after completion.
    expect(Object.keys(upstreamHeaders)).toHaveLength(0);
    expect(logs).toHaveLength(1);
    expect(logs[0].outcome).toBe("allowed");
    expect(logs[0].sseSummary).toEqual({
      terminalEvent: "response.completed",
      truncatedEof: false,
      responseId: "resp_99",
      usage: { inputTokens: 12, outputTokens: 34, totalTokens: 46 },
    });
    expect(JSON.stringify(logs[0])).not.toContain("ephemeral-secret-key");
    expect(JSON.stringify(logs[0])).not.toContain("sess-tok");
    expect(JSON.stringify(logs[0])).not.toContain("SENTINEL_SECRET_TEXT");
  });

  it("flags STREAM_TRUNCATED_EOF when an HTTP 200 SSE stream closes without a terminal event", async () => {
    const logs: ProxyAccessLogEntry[] = [];
    const fetchImpl = vi.fn(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n"));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });

    const { baseUrl } = await startProxy({
      upstreamGatewayUrl: "https://ai-gateway.internal",
      authorize: async () => ({
        decision: "allow",
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        upstream: { headers: { Authorization: "Bearer up-key" } },
      }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sseHeartbeatIntervalMs: 0,
      onAccessLog: (entry) => logs.push(entry),
    });

    const res = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer sess-tok",
        "X-Paperclip-Run-Id": "run-trunc",
        "X-Paperclip-Run-Generation": "1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-5.4", stream: true }),
    });
    expect(res.status).toBe(200);
    await res.text();

    expect(logs).toHaveLength(1);
    expect(logs[0].code).toBe("STREAM_TRUNCATED_EOF");
    expect(logs[0].sseSummary?.truncatedEof).toBe(true);
    expect(logs[0].sseSummary?.terminalEvent).toBeNull();
  });

  it("aborts in-flight upstream requests immediately when revokeRun or POST /internal/revocations is called", async () => {
    let capturedSignal: AbortSignal | undefined;
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });

    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined;
      resolveStarted();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
    });

    const { baseUrl, handle } = await startProxy({
      upstreamGatewayUrl: "https://ai-gateway.internal",
      internalAuthToken: "push-revoke-secret",
      authorize: async () => ({
        decision: "allow",
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        upstream: { headers: { Authorization: "Bearer ephemeral" } },
      }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const unauthRevoke = await fetch(`${baseUrl}${INTERNAL_REVOCATIONS_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: "run-live" }),
    });
    expect(unauthRevoke.status).toBe(401);

    const reqPromise = fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer sess-tok",
        "X-Paperclip-Run-Id": "run-live",
        "X-Paperclip-Run-Generation": "1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-5.4", stream: true }),
    });

    await started;
    expect(handle.activeStreamCount()).toBe(1);

    const revokeRes = await fetch(`${baseUrl}${INTERNAL_REVOCATIONS_PATH}`, {
      method: "POST",
      headers: {
        Authorization: "Bearer push-revoke-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ runId: "run-live", runGeneration: 1 }),
    });
    expect(revokeRes.status).toBe(200);
    expect(await revokeRes.json()).toEqual({
      revoked: true,
      runId: "run-live",
      runGeneration: 1,
      abortedStreams: 1,
    });
    expect(capturedSignal?.aborted).toBe(true);

    const res = await reqPromise;
    expect(res.status).toBe(499);
    expect(handle.activeStreamCount()).toBe(0);
  });

  it("streams end-to-end with createLongLivedUpstreamFetch (timeout: 0) over node:http", async () => {
    const upstream = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_http\"}}\n\n");
      res.end();
    });
    servers.push(upstream);
    const port = await new Promise<number>((resolve) => {
      upstream.listen(0, "127.0.0.1", () => {
        const addr = upstream.address();
        resolve(typeof addr === "object" && addr ? addr.port : 0);
      });
    });

    const longFetch = createLongLivedUpstreamFetch();
    const res = await longFetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.4" }),
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("resp_http");
  });

  it("handles chunk-split SSE frames cleanly in createSseAuditAccumulator", () => {
    const acc = createSseAuditAccumulator();
    acc.feed(new TextEncoder().encode("data: {\"type\":\"response."));
    acc.feed(new TextEncoder().encode("completed\",\"response\":{\"id\":\"r1\",\"usage\":{\"total_tokens\":7}}}\n\n"));
    expect(acc.finish(200, false)).toEqual({
      terminalEvent: "response.completed",
      truncatedEof: false,
      responseId: "r1",
      usage: { totalTokens: 7 },
    });
  });
});

describe("atomic lease token delivery via pod-exec stdin", () => {
  it("builds a POSIX umask-077 chmod-0600 atomic mv command", () => {
    const cmd = buildAtomicLeaseTokenWriteCommand();
    expect(cmd[0]).toBe("/bin/sh");
    expect(cmd[1]).toBe("-c");
    expect(cmd[2]).toContain("umask 077");
    expect(cmd[2]).toContain("chmod 0600");
    expect(cmd[2]).toContain(`mv -f "$tmp" '${DEFAULT_LEASE_TOKEN_PATH}'`);
  });

  it("delivers token via stdin without placing token in command arguments", async () => {
    const execMock = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    await deliverLeaseTokenViaStdin(
      {} as never,
      {
        namespace: "paperclip-tenant",
        podName: "sandbox-1",
        containerName: "agent",
        token: "one-time-lease-secret-xyz",
      },
      execMock as never,
    );
    expect(execMock).toHaveBeenCalledOnce();
    const [, ns, pod, container, command, stdin] = execMock.mock.calls[0] as unknown as [
      unknown,
      string,
      string,
      string,
      string[],
      string,
    ];
    expect(ns).toBe("paperclip-tenant");
    expect(pod).toBe("sandbox-1");
    expect(container).toBe("agent");
    expect(command.join(" ")).not.toContain("one-time-lease-secret-xyz");
    expect(stdin).toBe("one-time-lease-secret-xyz");
  });
});

import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  GATEWAY_AUTHORIZE_PATH,
  GATEWAY_RECONCILE_PATH,
  parseGatewayProxyConfig,
  startDelegraGatewayProxyServer,
  type RunningGatewayProxyServer,
} from "../../src/gateway-proxy-server.js";
import type { ProxyAccessLogEntry } from "../../src/gateway-proxy.js";

const INTERNAL_ENV_KEY = ["DELEGRA", "GATEWAY", "INTERNAL", "TOKEN"].join("_");

function bearer(value: string): string {
  return `Bearer ${value}`;
}

function listenServer(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe("gateway-proxy-server", () => {
  const serversToClose: Server[] = [];
  const proxiesToStop: RunningGatewayProxyServer[] = [];

  afterEach(async () => {
    while (proxiesToStop.length > 0) {
      await proxiesToStop.pop()!.stop();
    }
    while (serversToClose.length > 0) {
      await closeServer(serversToClose.pop()!);
    }
  });

  it("fails closed when required environment variables are missing or invalid", () => {
    expect(() => parseGatewayProxyConfig({})).toThrow(/PAPERCLIP_SERVER_URL/);
    expect(() =>
      parseGatewayProxyConfig({
        PAPERCLIP_SERVER_URL: "ftp://invalid.local",
        UPSTREAM_GATEWAY_URL: "https://gateway.local",
        [INTERNAL_ENV_KEY]: "test-value",
      }),
    ).toThrow(/http: or https:/);
    expect(() =>
      parseGatewayProxyConfig({
        PAPERCLIP_SERVER_URL: "http://paperclip-server:3100",
        [INTERNAL_ENV_KEY]: "test-value",
      }),
    ).toThrow(/UPSTREAM_GATEWAY_URL/);
    expect(() =>
      parseGatewayProxyConfig({
        PAPERCLIP_SERVER_URL: "http://paperclip-server:3100",
        UPSTREAM_GATEWAY_URL: "https://gateway.local",
      }),
    ).toThrow(new RegExp(INTERNAL_ENV_KEY));

    const valid = parseGatewayProxyConfig({
      PAPERCLIP_SERVER_URL: "http://paperclip-server:3100/",
      UPSTREAM_GATEWAY_URL: "https://gateway.local/",
      [INTERNAL_ENV_KEY]: "internal-val",
    });
    expect(valid.port).toBe(8443);
    expect(valid.host).toBe("0.0.0.0");
    expect(valid.paperclipServerUrl).toBe("http://paperclip-server:3100");
    expect(valid.upstreamGatewayUrl).toBe("https://gateway.local");
  });

  it("authorizes against paperclip-server, forwards allowed requests, and never logs credentials", async () => {
    const internalVal = "internal-shared-value";
    const sessionVal = "run-session-val-1";
    const upstreamVal = "mock-ephemeral-upstream-val";

    const authzRequests: Array<{ authHeader?: string; sessionHeader?: string; body: Record<string, unknown> }> = [];
    const upstreamRequests: Array<{ authHeader?: string; body: string }> = [];

    const controlPlane = createServer(async (req, res) => {
      if (req.method === "POST" && req.url === GATEWAY_AUTHORIZE_PATH) {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(Buffer.from(c));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        authzRequests.push({
          authHeader: req.headers.authorization,
          sessionHeader:
            typeof req.headers["x-delegra-session-token"] === "string"
              ? req.headers["x-delegra-session-token"]
              : undefined,
          body,
        });

        if (body.requestedModel === "forbidden-model") {
          res.statusCode = 403;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              decision: "deny",
              status: 403,
              code: "POLICY_OR_SCOPE_DENIED",
              message: "Model not allowed.",
              retryable: false,
            }),
          );
          return;
        }

        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            decision: "allow",
            leaseExpiresAt: "2026-12-01T00:00:00.000Z",
            upstream: {
              headers: {
                Authorization: bearer(upstreamVal),
              },
            },
          }),
        );
        return;
      }

      res.statusCode = 404;
      res.end();
    });
    serversToClose.push(controlPlane);
    const cpPort = await listenServer(controlPlane);

    const upstream = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.from(c));
      upstreamRequests.push({
        authHeader: req.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ id: "resp_1", status: "completed" }));
    });
    serversToClose.push(upstream);
    const upstreamPort = await listenServer(upstream);

    const logs: ProxyAccessLogEntry[] = [];
    const proxy = await startDelegraGatewayProxyServer(
      parseGatewayProxyConfig({
        PORT: "0",
        HOST: "127.0.0.1",
        PAPERCLIP_SERVER_URL: `http://127.0.0.1:${cpPort}`,
        UPSTREAM_GATEWAY_URL: `http://127.0.0.1:${upstreamPort}`,
        [INTERNAL_ENV_KEY]: internalVal,
        GATEWAY_RECONCILE_INTERVAL_MS: "0",
      }),
      { onAccessLog: (entry) => logs.push(entry) },
    );
    proxiesToStop.push(proxy);

    const allowRes = await fetch(`http://127.0.0.1:${proxy.port}/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: bearer(sessionVal),
        "X-Paperclip-Run-Id": "run-100",
        "X-Paperclip-Run-Generation": "1",
        "X-Paperclip-Agent-Id": "agent-1",
      },
      body: JSON.stringify({ model: "gpt-5-mini", input: "SENTINEL_USER_PROMPT" }),
    });
    expect(allowRes.status).toBe(200);
    expect(await allowRes.json()).toEqual({ id: "resp_1", status: "completed" });
    expect(authzRequests).toHaveLength(1);
    expect(authzRequests[0]?.authHeader).toBe(bearer(internalVal));
    expect(authzRequests[0]?.sessionHeader).toBe(sessionVal);
    expect(upstreamRequests).toHaveLength(1);
    expect(upstreamRequests[0]?.authHeader).toBe(bearer(upstreamVal));

    const denyRes = await fetch(`http://127.0.0.1:${proxy.port}/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: bearer(sessionVal),
        "X-Paperclip-Run-Id": "run-100",
        "X-Paperclip-Run-Generation": "1",
      },
      body: JSON.stringify({ model: "forbidden-model" }),
    });
    expect(denyRes.status).toBe(403);
    expect(upstreamRequests).toHaveLength(1);

    const serializedLogs = JSON.stringify(logs);
    expect(serializedLogs).not.toContain(upstreamVal);
    expect(serializedLogs).not.toContain(internalVal);
    expect(serializedLogs).not.toContain(sessionVal);
    expect(serializedLogs).not.toContain("SENTINEL_USER_PROMPT");
  });

  it("reconciles active leases and revokes disappeared or superseded runs", async () => {
    const reconcileVal = "reconcile-internal-value";
    let activeLeases: Array<{ runId: string; runGeneration: number }> = [
      { runId: "run-a", runGeneration: 1 },
      { runId: "run-b", runGeneration: 1 },
    ];

    const controlPlane = createServer((req, res) => {
      if (req.method === "GET" && req.url === GATEWAY_RECONCILE_PATH) {
        expect(req.headers.authorization).toBe(bearer(reconcileVal));
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ leases: activeLeases, generatedAt: new Date().toISOString() }));
        return;
      }
      if (req.method === "POST" && req.url === GATEWAY_AUTHORIZE_PATH) {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            decision: "allow",
            leaseExpiresAt: "2026-12-01T00:00:00.000Z",
            upstream: { headers: { Authorization: bearer("up-val") } },
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    serversToClose.push(controlPlane);
    const cpPort = await listenServer(controlPlane);

    const upstream = createServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
    serversToClose.push(upstream);
    const upstreamPort = await listenServer(upstream);

    const proxy = await startDelegraGatewayProxyServer(
      parseGatewayProxyConfig({
        PORT: "0",
        HOST: "127.0.0.1",
        PAPERCLIP_SERVER_URL: `http://127.0.0.1:${cpPort}`,
        UPSTREAM_GATEWAY_URL: `http://127.0.0.1:${upstreamPort}`,
        [INTERNAL_ENV_KEY]: reconcileVal,
        GATEWAY_RECONCILE_INTERVAL_MS: "0",
      }),
      { onAccessLog: () => undefined },
    );
    proxiesToStop.push(proxy);

    const first = await proxy.reconcileOnce();
    expect(first).toEqual({ activeCount: 2, revokedCount: 0 });

    activeLeases = [{ runId: "run-b", runGeneration: 2 }];
    const second = await proxy.reconcileOnce();
    expect(second).toEqual({ activeCount: 1, revokedCount: 2 });

    const staleRes = await fetch(`http://127.0.0.1:${proxy.port}/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: bearer("val-b"),
        "X-Paperclip-Run-Id": "run-b",
        "X-Paperclip-Run-Generation": "1",
      },
      body: JSON.stringify({ model: "gpt-5-mini" }),
    });
    expect(staleRes.status).toBe(403);

    const freshRes = await fetch(`http://127.0.0.1:${proxy.port}/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: bearer("val-b2"),
        "X-Paperclip-Run-Id": "run-b",
        "X-Paperclip-Run-Generation": "2",
      },
      body: JSON.stringify({ model: "gpt-5-mini" }),
    });
    expect(freshRes.status).toBe(200);
  });
});

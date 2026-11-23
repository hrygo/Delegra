import {
  parseGatewayProxyConfig,
  startDelegraGatewayProxyServer,
} from "./gateway-proxy-server.js";

async function main(): Promise<void> {
  const config = parseGatewayProxyConfig(process.env);
  const running = await startDelegraGatewayProxyServer(config);

  process.stdout.write(
    `${JSON.stringify({
      event: "gateway_proxy_started",
      host: running.host,
      port: running.port,
      reconcileIntervalMs: config.reconcileIntervalMs,
      sseHeartbeatIntervalMs: config.sseHeartbeatIntervalMs,
      maxBodyBytes: config.maxBodyBytes,
    })}\n`,
  );

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`${JSON.stringify({ event: "gateway_proxy_stopping", signal })}\n`);
    void running
      .stop()
      .then(() => {
        process.stdout.write(`${JSON.stringify({ event: "gateway_proxy_stopped" })}\n`);
        process.exit(0);
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `${JSON.stringify({ event: "gateway_proxy_shutdown_error", message })}\n`,
        );
        process.exit(1);
      });
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

void main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${JSON.stringify({ event: "gateway_proxy_fatal", message })}\n`);
  process.exit(1);
});

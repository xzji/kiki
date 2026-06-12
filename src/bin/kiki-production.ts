#!/usr/bin/env node

import { createServer, type IncomingMessage } from "http";
import { parse } from "url";
import type { Duplex } from "stream";

import next from "next";

import { MACHINE_TUNNEL_WS_PATH } from "@/lib/server/tunnel/machineTunnelProtocol";
import { bootstrapCloudControlPlane } from "@/lib/server/orchestrator/cloudOrchestratorRunner";
import { getPublicBaseUrl } from "@/lib/server/http/publicBaseUrl";

process.env.KIKI_ORCHESTRATOR_MODE = process.env.KIKI_ORCHESTRATOR_MODE ?? "cloud";
process.env.KIKI_LOCAL_CLI_ONLY = process.env.KIKI_LOCAL_CLI_ONLY ?? "true";

const hostname = process.env.HOSTNAME ?? "0.0.0.0";
const port = Number(process.env.PORT ?? "3000");

const app = next({ dev: false, hostname, port });
const handle = app.getRequestHandler();

type UpgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer) => void;

void app.prepare().then(() => {
  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url ?? "/", true);
    void handle(req, res, parsedUrl);
  });

  bootstrapCloudControlPlane(server);

  let nextUpgradeHandler: UpgradeHandler | null = null;
  const registerServerListener = server.on.bind(server);
  server.on = ((eventName: string, listener: (...args: unknown[]) => void) => {
    if (eventName === "upgrade") {
      nextUpgradeHandler = listener as UpgradeHandler;
      return server;
    }
    return registerServerListener(eventName, listener);
  }) as typeof server.on;

  registerServerListener("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === MACHINE_TUNNEL_WS_PATH) return;
    if (nextUpgradeHandler) {
      nextUpgradeHandler(request, socket, head);
      return;
    }
    socket.destroy();
  });

  server.listen(port, hostname, () => {
    const publicUrl = getPublicBaseUrl();
    console.log(`[kiki-production] listening on ${hostname}:${port}`);
    console.log(`[kiki-production] public URL: ${publicUrl}`);
    console.log(`[kiki-production] remote daemon: pnpm daemon:remote --server-url ${publicUrl} --api-key <key>`);
  });
});

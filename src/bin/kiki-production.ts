#!/usr/bin/env node

import { createServer } from "http";
import { parse } from "url";

import next from "next";

import { bootstrapCloudControlPlane } from "@/lib/server/orchestrator/cloudOrchestratorRunner";
import { getPublicBaseUrl } from "@/lib/server/http/publicBaseUrl";

process.env.KIKI_ORCHESTRATOR_MODE = process.env.KIKI_ORCHESTRATOR_MODE ?? "cloud";
process.env.KIKI_LOCAL_CLI_ONLY = process.env.KIKI_LOCAL_CLI_ONLY ?? "true";

const hostname = process.env.HOSTNAME ?? "0.0.0.0";
const port = Number(process.env.PORT ?? "3000");

const app = next({ dev: false, hostname, port });
const handle = app.getRequestHandler();

void app.prepare().then(() => {
  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url ?? "/", true);
    void handle(req, res, parsedUrl);
  });

  bootstrapCloudControlPlane(server);

  server.listen(port, hostname, () => {
    const publicUrl = getPublicBaseUrl();
    console.log(`[kiki-production] listening on ${hostname}:${port}`);
    console.log(`[kiki-production] public URL: ${publicUrl}`);
    console.log(`[kiki-production] remote daemon: pnpm daemon:remote --server-url ${publicUrl} --api-key <key>`);
  });
});

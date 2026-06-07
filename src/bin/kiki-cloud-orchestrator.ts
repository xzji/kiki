#!/usr/bin/env node

process.env.KIKI_ORCHESTRATOR_MODE = process.env.KIKI_ORCHESTRATOR_MODE ?? "cloud";

import { runCloudOrchestratorLoop } from "@/lib/server/orchestrator/cloudOrchestratorRunner";

void runCloudOrchestratorLoop().catch((error) => {
  console.error("[kiki-cloud-orchestrator] fatal error", error);
  process.exitCode = 1;
});

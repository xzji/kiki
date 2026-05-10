#!/usr/bin/env node

import { runRuntimeDaemonLoop } from "@/lib/daemon/daemonRunner";

void runRuntimeDaemonLoop().catch((error) => {
  console.error("[kiki-runtime-daemon] fatal error", error);
  process.exitCode = 1;
});

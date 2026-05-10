import { runRuntimeDaemonLoop } from "@/lib/daemon/daemonRunner";

async function main() {
  await runRuntimeDaemonLoop();
}

void main().catch((error) => {
  console.error("[start-worker] fatal error", error);
  process.exitCode = 1;
});

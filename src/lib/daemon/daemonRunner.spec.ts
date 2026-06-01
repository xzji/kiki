import assert from "node:assert/strict";

import { recordThreadLoopDaemonStartedLog } from "@/lib/daemon/daemonRunner";

export function runDaemonRunnerSpecs() {
  const logs: string[] = [];

  recordThreadLoopDaemonStartedLog((message) => logs.push(message));

  assert.deepEqual(logs, ["threadLoopDaemon: started"]);
}

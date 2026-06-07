#!/usr/bin/env node

import { runRemoteDaemonLoop } from "@/lib/daemon/remoteDaemonLoop";
import { runRuntimeDaemonLoop } from "@/lib/daemon/daemonRunner";
import { DEFAULT_LOCAL_USER_ID, runWithUserContext } from "@/lib/server/context/userContext";
import { provisionUserWorkspace } from "@/lib/server/services/userProvisioning";

function readArg(flag: string) {
  const direct = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  if (direct) return direct.slice(flag.length + 1);
  const index = process.argv.indexOf(flag);
  if (index >= 0) return process.argv[index + 1];
  return undefined;
}

const remote = process.argv.includes("--remote");
const serverUrl = readArg("--server-url");
const apiKey = readArg("--api-key");

if (remote) {
  if (!serverUrl || !apiKey) {
    console.error("远程模式需要 --server-url 与 --api-key");
    process.exitCode = 1;
  } else {
    void runRemoteDaemonLoop({ serverUrl, apiKey }).catch((error) => {
      console.error("[kiki-runtime-daemon] remote fatal error", error);
      process.exitCode = 1;
    });
  }
} else {
  provisionUserWorkspace(DEFAULT_LOCAL_USER_ID);
  void runWithUserContext(DEFAULT_LOCAL_USER_ID, () => runRuntimeDaemonLoop()).catch((error) => {
    console.error("[kiki-runtime-daemon] fatal error", error);
    process.exitCode = 1;
  });
}

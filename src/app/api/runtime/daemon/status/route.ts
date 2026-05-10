import { NextResponse } from "next/server";
import fs from "fs";

import { readRuntimeDaemonConfig } from "@/lib/daemon/daemonConfig";
import { readRuntimeDaemonDeviceState, readRuntimeDaemonState } from "@/lib/daemon/daemonState";
import { getLaunchAgentPlistPath } from "@/lib/server/storage/paths";

export const runtime = "nodejs";

export async function GET() {
  const config = readRuntimeDaemonConfig();
  const state = readRuntimeDaemonState();
  const device = readRuntimeDaemonDeviceState();

  return NextResponse.json({
    config,
    state,
    device,
    launchAgentInstalled: fs.existsSync(getLaunchAgentPlistPath()),
    launchAgentPath: getLaunchAgentPlistPath(),
  });
}

import { NextResponse } from "next/server";
import fs from "fs";

import { readRuntimeDaemonConfig } from "@/lib/daemon/daemonConfig";
import { readRuntimeDaemonDeviceState, readRuntimeDaemonState } from "@/lib/daemon/daemonState";
import { getDatabase, getDatabaseRuntimeInfo } from "@/lib/server/db/client";
import { getLaunchAgentPlistPath } from "@/lib/server/storage/paths";
import { withAuth } from "@/lib/server/http/withAuth";

export const runtime = "nodejs";

async function GETHandler() {
  const config = readRuntimeDaemonConfig();
  const state = readRuntimeDaemonState();
  const device = readRuntimeDaemonDeviceState();

  // 确保 web 进程已打开自己的 DB，再读取其实际路径/inode。
  getDatabase();
  const webDb = getDatabaseRuntimeInfo();
  const workerDb = { path: state?.dbPath ?? null, inode: state?.dbInode ?? null };
  // 仅当 worker 已上报 inode 时才判定；两端 inode 不一致即为读写分裂。
  const sameDatabase =
    workerDb.inode === null || webDb.inode === null ? null : workerDb.inode === webDb.inode;

  return NextResponse.json({
    config,
    state,
    device,
    dbConsistency: {
      web: webDb,
      worker: workerDb,
      sameDatabase,
    },
    launchAgentInstalled: fs.existsSync(getLaunchAgentPlistPath()),
    launchAgentPath: getLaunchAgentPlistPath(),
  });
}

export const GET = withAuth(GETHandler);

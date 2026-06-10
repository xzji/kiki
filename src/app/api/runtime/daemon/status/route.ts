import { NextResponse } from "next/server";
import fs from "fs";

import { readRuntimeDaemonConfig } from "@/lib/daemon/daemonConfig";
import { readRuntimeDaemonDeviceState, readRuntimeDaemonState } from "@/lib/daemon/daemonState";
import { getDatabase, getDatabaseRuntimeInfo } from "@/lib/server/db/client";
import { getLaunchAgentPlistPath } from "@/lib/server/storage/paths";
import { withAuth } from "@/lib/server/http/withAuth";
import { isServerLocalCliDisabled } from "@/lib/server/runtime/cloudExecutionPolicy";
import { getRuntimeDaemonServiceStatusForUser } from "@/lib/server/tunnel/remoteRuntimeProxy";
import type { RemoteDaemonServiceStatus } from "@/lib/server/tunnel/tunnelHub";

export const runtime = "nodejs";

function localServiceStatus(): RemoteDaemonServiceStatus {
  const launchAgentInstalled = fs.existsSync(getLaunchAgentPlistPath());
  return {
    platform: process.platform,
    kind: process.platform === "darwin" ? "launchd" : "unsupported",
    installed: launchAgentInstalled,
    running: launchAgentInstalled,
    path: getLaunchAgentPlistPath(),
  };
}

function buildBasePayload() {
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

  return {
    config,
    state,
    device,
    dbConsistency: {
      web: webDb,
      worker: workerDb,
      sameDatabase,
    },
  };
}

async function GETHandler(_request: Request, context: { userId: string }) {
  const basePayload = buildBasePayload();

  if (isServerLocalCliDisabled()) {
    try {
      const remote = await getRuntimeDaemonServiceStatusForUser(context.userId);
      return NextResponse.json({
        ...basePayload,
        source: remote.source,
        service: remote.service,
        message: remote.message,
        launchAgentInstalled: remote.service.installed,
        launchAgentPath: remote.service.path,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "本机后台服务状态获取失败";
      const service: RemoteDaemonServiceStatus = {
        platform: "unknown",
        kind: "unsupported",
        installed: false,
        running: false,
        path: "",
      };
      return NextResponse.json({
        ...basePayload,
        source: "remote",
        service,
        message,
        launchAgentInstalled: false,
        launchAgentPath: "",
      });
    }
  }

  const service = localServiceStatus();
  return NextResponse.json({
    ...basePayload,
    source: "local",
    service,
    launchAgentInstalled: service.installed,
    launchAgentPath: service.path,
  });
}

export const GET = withAuth(GETHandler);

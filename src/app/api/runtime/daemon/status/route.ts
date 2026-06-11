import { NextResponse } from "next/server";
import fs from "fs";

import { readRuntimeDaemonConfig } from "@/lib/daemon/daemonConfig";
import { readRuntimeDaemonDeviceState, readRuntimeDaemonState } from "@/lib/daemon/daemonState";
import type { RuntimeDaemonDeviceState, RuntimeDaemonState } from "@/lib/daemon/daemonState";
import { getDatabase, getDatabaseRuntimeInfo } from "@/lib/server/db/client";
import { getLaunchAgentPlistPath } from "@/lib/server/storage/paths";
import { withAuth } from "@/lib/server/http/withAuth";
import { isServerLocalCliDisabled } from "@/lib/server/runtime/cloudExecutionPolicy";
import { getRuntimeDaemonServiceStatusForUser } from "@/lib/server/tunnel/remoteRuntimeProxy";
import { listMachinesForUser, type MachineRecord } from "@/lib/server/services/machineService";
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

/**
 * 云端模式下，daemon 跑在用户本机，其心跳/设备信息写在本机文件系统，
 * web 进程读不到本地状态文件。此处改用服务端 machines 表的 last_seen_at 作为
 * 单一事实来源（与"连接电脑在线/离线"判定一致），优先取在线机器，其次取最近一次连接的机器。
 */
function pickHeartbeatMachine(userId: string): MachineRecord | null {
  const machines = listMachinesForUser(userId);
  if (machines.length === 0) return null;
  const online = machines.find((machine) => machine.online);
  if (online) return online;
  const withHeartbeat = machines
    .filter((machine) => machine.lastSeenAt)
    .sort(
      (a, b) =>
        new Date(b.lastSeenAt as string).getTime() - new Date(a.lastSeenAt as string).getTime(),
    );
  return withHeartbeat[0] ?? machines[0];
}

/** 基于机器记录覆盖 state/device 的心跳与设备字段，保留 worker 上报的其它字段（如 db 自检信息）。 */
function withMachineHeartbeat(
  base: { state: RuntimeDaemonState | null; device: RuntimeDaemonDeviceState | null },
  machine: MachineRecord | null,
): { state: RuntimeDaemonState | null; device: RuntimeDaemonDeviceState | null } {
  if (!machine) {
    return { state: base.state, device: base.device };
  }
  const heartbeatAt = machine.lastSeenAt ?? undefined;
  const state: RuntimeDaemonState = {
    ...(base.state ?? {}),
    deviceId: machine.id,
    status: machine.online ? "running" : "idle",
    lastHeartbeatAt: heartbeatAt,
    updatedAt: base.state?.updatedAt ?? heartbeatAt ?? new Date().toISOString(),
  };
  const device: RuntimeDaemonDeviceState = {
    deviceId: machine.id,
    installedAt: base.device?.installedAt ?? machine.createdAt,
    daemonVersion: base.device?.daemonVersion ?? "",
  };
  return { state, device };
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
    // 云端模式：daemon 在用户本机，心跳/设备信息以服务端 machines 表为单一事实来源。
    const heartbeatMachine = pickHeartbeatMachine(context.userId);
    const { state, device } = withMachineHeartbeat(
      { state: basePayload.state, device: basePayload.device },
      heartbeatMachine,
    );
    const cloudPayload = { ...basePayload, state, device };
    try {
      const remote = await getRuntimeDaemonServiceStatusForUser(context.userId);
      return NextResponse.json({
        ...cloudPayload,
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
        ...cloudPayload,
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

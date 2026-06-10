import { NextRequest, NextResponse } from "next/server";

import {
  installAndLoadLaunchAgent,
  isLaunchAgentInstalled,
  unloadAndRemoveLaunchAgent,
} from "@/lib/daemon/launchAgent";
import { readRuntimeDaemonConfig, writeRuntimeDaemonConfig } from "@/lib/daemon/daemonConfig";
import { normalizeRuntimeFilePolicy } from "@/lib/runtime/toolPolicy";
import { getLaunchAgentPlistPath } from "@/lib/server/storage/paths";
import type { RuntimeFilePolicy, RuntimePermissionMode } from "@/types/runtime";
import { withAuth } from "@/lib/server/http/withAuth";
import { isServerLocalCliDisabled } from "@/lib/server/runtime/cloudExecutionPolicy";
import { setRuntimeDaemonServiceAutostartForUser } from "@/lib/server/tunnel/remoteRuntimeProxy";
import type { RemoteDaemonServiceStatus } from "@/lib/server/tunnel/tunnelHub";

export const runtime = "nodejs";

type TogglePayload = {
  enabled?: boolean;
  environment?: {
    name?: string;
    workingDirectory?: string;
    cliPath?: string;
    permissionMode?: RuntimePermissionMode;
    filePolicy?: RuntimeFilePolicy;
  };
};

function localServiceStatus(): RemoteDaemonServiceStatus {
  const launchAgentInstalled = isLaunchAgentInstalled();
  return {
    platform: process.platform,
    kind: process.platform === "darwin" ? "launchd" : "unsupported",
    installed: launchAgentInstalled,
    running: launchAgentInstalled,
    path: getLaunchAgentPlistPath(),
  };
}

function offlineRemoteServiceStatus(): RemoteDaemonServiceStatus {
  return {
    platform: "unknown",
    kind: "unsupported",
    installed: false,
    running: false,
    path: "",
  };
}

async function POSTHandler(request: NextRequest, context: { userId: string }) {
  try {
    const body = (await request.json()) as TogglePayload;

    if (typeof body.enabled !== "boolean") {
      return NextResponse.json({ ok: false, message: "缺少 enabled 参数" }, { status: 400 });
    }

    const currentConfig = readRuntimeDaemonConfig();

    if (isServerLocalCliDisabled()) {
      if (body.enabled && (!body.environment?.workingDirectory?.trim() || !body.environment.cliPath?.trim())) {
        return NextResponse.json({ ok: false, message: "缺少本地 Runtime 环境信息" }, { status: 400 });
      }

      const remote = await setRuntimeDaemonServiceAutostartForUser(context.userId, body.enabled);
      return NextResponse.json({
        ok: true,
        config: currentConfig,
        source: remote.source,
        service: remote.service,
        message: remote.message,
        launchAgentInstalled: remote.service.installed,
        launchAgentPath: remote.service.path,
      });
    }

    if (body.enabled) {
      if (!body.environment?.workingDirectory?.trim() || !body.environment.cliPath?.trim()) {
        return NextResponse.json({ ok: false, message: "缺少本地 Runtime 环境信息" }, { status: 400 });
      }

      const nextConfig = {
        ...currentConfig,
        name: body.environment.name?.trim() || currentConfig.name,
        workingDirectory: body.environment.workingDirectory.trim(),
        cliPath: body.environment.cliPath.trim(),
        permissionMode: body.environment.permissionMode || currentConfig.permissionMode,
        filePolicy: normalizeRuntimeFilePolicy(body.environment.filePolicy ?? currentConfig.filePolicy),
        autoStart: true,
      };

      await installAndLoadLaunchAgent();
      writeRuntimeDaemonConfig(nextConfig);
    } else {
      await unloadAndRemoveLaunchAgent();

      writeRuntimeDaemonConfig({
        ...currentConfig,
        autoStart: false,
      });
    }

    const nextConfig = readRuntimeDaemonConfig();
    const service = localServiceStatus();

    return NextResponse.json({
      ok: true,
      config: nextConfig,
      source: "local",
      service,
      launchAgentInstalled: service.installed,
      launchAgentPath: service.path,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "24h 运行设置失败";
    const remoteSource = isServerLocalCliDisabled();
    const service = remoteSource ? offlineRemoteServiceStatus() : localServiceStatus();
    return NextResponse.json(
      {
        ok: false,
        message,
        config: readRuntimeDaemonConfig(),
        source: remoteSource ? "remote" : "local",
        service,
        launchAgentInstalled: service.installed,
        launchAgentPath: service.path,
      },
      { status: 500 },
    );
  }
}

export const POST = withAuth(POSTHandler);

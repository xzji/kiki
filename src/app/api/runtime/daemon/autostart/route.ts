import { NextRequest, NextResponse } from "next/server";

import {
  installAndLoadLaunchAgent,
  isLaunchAgentInstalled,
  unloadAndRemoveLaunchAgent,
} from "@/lib/daemon/launchAgent";
import { readRuntimeDaemonConfig, writeRuntimeDaemonConfig } from "@/lib/daemon/daemonConfig";
import { getLaunchAgentPlistPath } from "@/lib/server/storage/paths";
import type { RuntimePermissionMode } from "@/types/runtime";

export const runtime = "nodejs";

type TogglePayload = {
  enabled?: boolean;
  environment?: {
    name?: string;
    workingDirectory?: string;
    cliPath?: string;
    permissionMode?: RuntimePermissionMode;
  };
};

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as TogglePayload;

    if (typeof body.enabled !== "boolean") {
      return NextResponse.json({ ok: false, message: "缺少 enabled 参数" }, { status: 400 });
    }

    const currentConfig = readRuntimeDaemonConfig();

    if (body.enabled) {
      if (!body.environment?.workingDirectory?.trim() || !body.environment.cliPath?.trim()) {
        return NextResponse.json({ ok: false, message: "缺少本地 Runtime 环境信息" }, { status: 400 });
      }

      writeRuntimeDaemonConfig({
        ...currentConfig,
        name: body.environment.name?.trim() || currentConfig.name,
        workingDirectory: body.environment.workingDirectory.trim(),
        cliPath: body.environment.cliPath.trim(),
        permissionMode: body.environment.permissionMode || currentConfig.permissionMode,
        autoStart: true,
      });

      await installAndLoadLaunchAgent();
    } else {
      writeRuntimeDaemonConfig({
        ...currentConfig,
        autoStart: false,
      });

      await unloadAndRemoveLaunchAgent();
    }

    const nextConfig = readRuntimeDaemonConfig();

    return NextResponse.json({
      ok: true,
      config: nextConfig,
      launchAgentInstalled: isLaunchAgentInstalled(),
      launchAgentPath: getLaunchAgentPlistPath(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "24h 运行设置失败";
    return NextResponse.json(
      {
        ok: false,
        message,
        config: readRuntimeDaemonConfig(),
        launchAgentInstalled: isLaunchAgentInstalled(),
        launchAgentPath: getLaunchAgentPlistPath(),
      },
      { status: 500 },
    );
  }
}

import { NextRequest, NextResponse } from "next/server";

import { readRuntimeDaemonConfig, writeRuntimeDaemonConfig } from "@/lib/daemon/daemonConfig";
import { withAuth } from "@/lib/server/http/withAuth";
import { writeUserRuntimeSettings } from "@/lib/server/repositories/userRuntimeSettingsRepository";
import { isServerLocalCliDisabled } from "@/lib/server/runtime/cloudExecutionPolicy";
import { applyUserRuntimeSettingsToDaemonConfig } from "@/lib/server/runtime/userRuntimeConfig";

export const runtime = "nodejs";

type ConcurrencyPayload = {
  maxConcurrentTasks?: number;
};

async function POSTHandler(request: NextRequest) {
  try {
    const body = (await request.json()) as ConcurrencyPayload;
    if (typeof body.maxConcurrentTasks !== "number" || !Number.isFinite(body.maxConcurrentTasks)) {
      return NextResponse.json({ ok: false, message: "缺少 maxConcurrentTasks 参数" }, { status: 400 });
    }

    const settings = writeUserRuntimeSettings({
      maxConcurrentTasks: body.maxConcurrentTasks,
    });
    if (!isServerLocalCliDisabled()) {
      const currentConfig = readRuntimeDaemonConfig();
      // 本地模式同步写 daemon 配置文件；云端调度以账号级 settings 为权威来源。
      writeRuntimeDaemonConfig({
        ...currentConfig,
        maxConcurrentTasks: settings.maxConcurrentTasks,
      });
    }
    const nextConfig = applyUserRuntimeSettingsToDaemonConfig(readRuntimeDaemonConfig());

    return NextResponse.json({ ok: true, config: nextConfig });
  } catch (error) {
    const message = error instanceof Error ? error.message : "并发上限设置失败";
    return NextResponse.json(
      { ok: false, message, config: applyUserRuntimeSettingsToDaemonConfig(readRuntimeDaemonConfig()) },
      { status: 500 },
    );
  }
}

export const POST = withAuth(POSTHandler);

import { NextRequest, NextResponse } from "next/server";

import { readRuntimeDaemonConfig } from "@/lib/daemon/daemonConfig";
import {
  pauseAllTaskExecution,
  resumeAllTaskExecution,
} from "@/lib/server/scheduling/dispatchPauseService";
import { withAuth } from "@/lib/server/http/withAuth";
import { applyUserRuntimeSettingsToDaemonConfig } from "@/lib/server/runtime/userRuntimeConfig";

export const runtime = "nodejs";

type DispatchPausePayload = {
  paused?: boolean;
};

async function POSTHandler(request: NextRequest) {
  try {
    const body = (await request.json()) as DispatchPausePayload;
    if (typeof body.paused !== "boolean") {
      return NextResponse.json({ ok: false, message: "缺少 paused 参数" }, { status: 400 });
    }

    const result = body.paused ? pauseAllTaskExecution() : resumeAllTaskExecution();
    const config = applyUserRuntimeSettingsToDaemonConfig(readRuntimeDaemonConfig());

    return NextResponse.json({
      ok: true,
      config,
      ...result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "任务调度暂停设置失败";
    return NextResponse.json(
      { ok: false, message, config: applyUserRuntimeSettingsToDaemonConfig(readRuntimeDaemonConfig()) },
      { status: 500 },
    );
  }
}

export const POST = withAuth(POSTHandler);

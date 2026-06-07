import { NextRequest, NextResponse } from "next/server";

import { readRuntimeDaemonConfig, writeRuntimeDaemonConfig } from "@/lib/daemon/daemonConfig";
import { withAuth } from "@/lib/server/http/withAuth";

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

    const currentConfig = readRuntimeDaemonConfig();
    // readRuntimeDaemonConfig 会对 maxConcurrentTasks 做 1~10 的边界保护后回读。
    writeRuntimeDaemonConfig({
      ...currentConfig,
      maxConcurrentTasks: body.maxConcurrentTasks,
    });
    const nextConfig = readRuntimeDaemonConfig();

    return NextResponse.json({ ok: true, config: nextConfig });
  } catch (error) {
    const message = error instanceof Error ? error.message : "并发上限设置失败";
    return NextResponse.json(
      { ok: false, message, config: readRuntimeDaemonConfig() },
      { status: 500 },
    );
  }
}

export const POST = withAuth(POSTHandler);

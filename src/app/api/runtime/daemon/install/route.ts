import { NextResponse } from "next/server";

import { installAndLoadLaunchAgent, isLaunchAgentInstalled } from "@/lib/daemon/launchAgent";
import { getLaunchAgentPlistPath } from "@/lib/server/storage/paths";
import { withAuth } from "@/lib/server/http/withAuth";

export const runtime = "nodejs";

async function POSTHandler() {
  try {
    const targetPath = await installAndLoadLaunchAgent();
    return NextResponse.json({
      ok: true,
      launchAgentInstalled: isLaunchAgentInstalled(),
      launchAgentPath: targetPath,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "LaunchAgent 安装失败";
    return NextResponse.json(
      {
        ok: false,
        message,
        launchAgentInstalled: isLaunchAgentInstalled(),
        launchAgentPath: getLaunchAgentPlistPath(),
      },
      { status: 500 },
    );
  }
}

export const POST = withAuth(POSTHandler);

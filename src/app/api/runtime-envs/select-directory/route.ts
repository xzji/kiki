import { NextResponse } from "next/server";

import { withAuth } from "@/lib/server/http/withAuth";
import { selectWorkingDirectoryForUser } from "@/lib/server/tunnel/remoteRuntimeProxy";

async function POSTHandler(_request: Request, context: { userId: string }) {
  try {
    const path = await selectWorkingDirectoryForUser(context.userId);
    if (!path) {
      return NextResponse.json({ canceled: true, reason: "已取消选择目录" }, { status: 400 });
    }
    return NextResponse.json({ path });
  } catch (error) {
    const message = error instanceof Error ? error.message : "目录选择失败";
    const useManualInput =
      message.includes("不支持原生目录选择器") ||
      message.includes("ENOENT") ||
      message.includes("osascript");
    return NextResponse.json(
      {
        canceled: false,
        useManualInput,
        reason: useManualInput ? "无法打开本机目录选择器，请手动输入路径" : message,
      },
      { status: useManualInput ? 400 : 500 },
    );
  }
}

export const POST = withAuth(POSTHandler);

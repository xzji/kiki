import { NextResponse } from "next/server";

import { resetLocalDataForDev } from "@/lib/server/dev/localDataReset";
import { withAuth } from "@/lib/server/http/withAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function POSTHandler() {
  try {
    const result = await resetLocalDataForDev();
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "清空本地测试数据失败";
    return NextResponse.json({ ok: false, message }, { status: 500 });
  }
}

export const POST = withAuth(POSTHandler);

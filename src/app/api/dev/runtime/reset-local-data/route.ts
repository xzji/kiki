import { NextResponse } from "next/server";

import { resetLocalDataForDev } from "@/lib/server/dev/localDataReset";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ ok: false, message: "该接口仅允许在开发环境使用" }, { status: 403 });
  }

  try {
    const result = await resetLocalDataForDev();
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "清空本地测试数据失败";
    return NextResponse.json({ ok: false, message }, { status: 500 });
  }
}

import { NextResponse } from "next/server";

import { safeInternetFetch } from "@/lib/server/network/safeInternetFetch";
import { getArtifactById } from "@/lib/server/repositories/artifactsRepository";
import { withAuth } from "@/lib/server/http/withAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MOCK_INTERNET_WEBAPP_ID = "artifact-demo-internet-webapp-1778950506965";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function currentOriginFromRequest(request: Request) {
  const url = new URL(request.url);
  return url.origin;
}

async function POSTHandler(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const artifact = getArtifactById(id);
  if (!artifact && id !== MOCK_INTERNET_WEBAPP_ID) return NextResponse.json({ ok: false, reason: "产物不存在" }, { status: 404 });
  if (artifact && artifact.kind !== "webapp") return NextResponse.json({ ok: false, reason: "产物不是可执行小应用" }, { status: 400 });
  if (artifact && artifact.manifest?.networkPolicy !== "internet") {
    return NextResponse.json({ ok: false, reason: "当前小应用未启用联网能力" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, reason: "请求 JSON 无法解析" }, { status: 400 });
  }
  if (!isRecord(body) || typeof body.url !== "string") {
    return NextResponse.json({ ok: false, reason: "url 必须是字符串" }, { status: 400 });
  }
  const responseType = body.responseType === "json" || body.responseType === "text" ? body.responseType : undefined;
  try {
    const result = await safeInternetFetch({
      url: body.url,
      responseType,
      currentOrigin: currentOriginFromRequest(request),
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      reason: error instanceof Error ? error.message : "公网请求失败",
    }, { status: 400 });
  }
}

export const POST = withAuth(POSTHandler);

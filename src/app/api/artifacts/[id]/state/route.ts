import { NextResponse } from "next/server";

import { getArtifactById } from "@/lib/server/repositories/artifactsRepository";
import {
  appendArtifactInteractionEvent,
  getArtifactInteractionState,
} from "@/lib/server/repositories/artifactInteractionRepository";
import { withAuth } from "@/lib/server/http/withAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_STATE_BYTES = 100 * 1024;
const MAX_EVENT_BYTES = 16 * 1024;
const MOCK_WEBAPP_ID = "artifact-demo-webapp-1778950506965";
const MOCK_INTERNET_WEBAPP_ID = "artifact-demo-internet-webapp-1778950506965";
const MOCK_WEBAPP_CONVERSATION_ID = "conv-goal-toefl";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function jsonSize(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
}

function normalizeEvent(value: unknown) {
  if (!isRecord(value) || typeof value.type !== "string" || !value.type.trim()) return undefined;
  const payload = isRecord(value.payload) ? value.payload : undefined;
  const event = {
    type: value.type.trim(),
    payload,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : undefined,
  };
  return jsonSize(event) <= MAX_EVENT_BYTES ? event : null;
}

async function GETHandler(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const artifact = getArtifactById(id);
  if (!artifact) {
    if (id === MOCK_WEBAPP_ID || id === MOCK_INTERNET_WEBAPP_ID) {
      const saved = getArtifactInteractionState(id);
      return NextResponse.json({
        ok: true,
        artifactId: id,
        state: saved?.state ?? (id === MOCK_WEBAPP_ID ? { budget: 300000, monthlyLimit: 6000 } : {}),
        events: saved?.events ?? [],
        updatedAt: saved?.updatedAt,
      });
    }
    return NextResponse.json({ ok: false, reason: "产物不存在" }, { status: 404 });
  }
  if (artifact.kind !== "webapp") {
    return NextResponse.json({ ok: false, reason: "产物不是可执行小应用" }, { status: 400 });
  }

  const saved = getArtifactInteractionState(artifact.id);
  return NextResponse.json({
    ok: true,
    artifactId: artifact.id,
    state: saved?.state ?? artifact.manifest?.initialState ?? {},
    events: saved?.events ?? [],
    updatedAt: saved?.updatedAt,
  });
}

async function POSTHandler(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const artifact = getArtifactById(id);
  if (!artifact) {
    if (id === MOCK_WEBAPP_ID || id === MOCK_INTERNET_WEBAPP_ID) {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return NextResponse.json({ ok: false, reason: "请求 JSON 无法解析" }, { status: 400 });
      }
      if (!isRecord(body)) {
        return NextResponse.json({ ok: false, reason: "请求体必须是 JSON object" }, { status: 400 });
      }
      const previous = getArtifactInteractionState(id);
      const nextState = isRecord(body.state)
        ? body.state
        : isRecord(body.patch)
          ? { ...(previous?.state ?? (id === MOCK_WEBAPP_ID ? { budget: 300000, monthlyLimit: 6000 } : {})), ...body.patch }
          : null;
      if (!nextState) {
        return NextResponse.json({ ok: false, reason: "state 或 patch 必须是 JSON object" }, { status: 400 });
      }
      if (jsonSize(nextState) > MAX_STATE_BYTES) {
        return NextResponse.json({ ok: false, reason: "保存失败，数据过大" }, { status: 413 });
      }
      const event = normalizeEvent(body.event);
      if (event === null) {
        return NextResponse.json({ ok: false, reason: "事件数据过大" }, { status: 413 });
      }
      const saved = appendArtifactInteractionEvent({
        artifactId: id,
        conversationId: MOCK_WEBAPP_CONVERSATION_ID,
        taskId: "task-toefl-listening",
        instanceId: id === MOCK_WEBAPP_ID ? "inst-surface-demo-webapp" : "inst-surface-demo-internet-webapp",
        state: nextState,
        event,
      });
      return NextResponse.json({
        ok: true,
        artifactId: id,
        state: saved?.state ?? nextState,
        events: saved?.events ?? [],
        updatedAt: saved?.updatedAt,
      });
    }
    return NextResponse.json({ ok: false, reason: "产物不存在" }, { status: 404 });
  }
  if (artifact.kind !== "webapp") {
    return NextResponse.json({ ok: false, reason: "产物不是可执行小应用" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, reason: "请求 JSON 无法解析" }, { status: 400 });
  }
  if (!isRecord(body)) {
    return NextResponse.json({ ok: false, reason: "请求体必须是 JSON object" }, { status: 400 });
  }

  const previous = getArtifactInteractionState(artifact.id);
  const nextState = isRecord(body.state)
    ? body.state
    : isRecord(body.patch)
      ? { ...(previous?.state ?? artifact.manifest?.initialState ?? {}), ...body.patch }
      : null;
  if (!nextState) {
    return NextResponse.json({ ok: false, reason: "state 或 patch 必须是 JSON object" }, { status: 400 });
  }
  if (jsonSize(nextState) > MAX_STATE_BYTES) {
    return NextResponse.json({ ok: false, reason: "保存失败，数据过大" }, { status: 413 });
  }

  const event = normalizeEvent(body.event);
  if (event === null) {
    return NextResponse.json({ ok: false, reason: "事件数据过大" }, { status: 413 });
  }

  const saved = appendArtifactInteractionEvent({
    artifactId: artifact.id,
    conversationId: artifact.conversationId,
    taskId: artifact.taskId,
    instanceId: artifact.instanceId,
    state: nextState,
    event,
  });

  return NextResponse.json({
    ok: true,
    artifactId: artifact.id,
    state: saved?.state ?? nextState,
    events: saved?.events ?? [],
    updatedAt: saved?.updatedAt,
  });
}

export const GET = withAuth(GETHandler);
export const POST = withAuth(POSTHandler);

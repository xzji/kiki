import { NextRequest, NextResponse } from "next/server";

import {
  upsertInboxItemState,
  type UpsertInboxItemStateInput,
} from "@/lib/server/repositories/inboxItemStateRepository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type InboxCommandAction =
  | "archive"
  | "snooze"
  | "unsnooze"
  | "favorite"
  | "unfavorite"
  | "mark_unread"
  | "mark_read";

type Body = {
  inboxItemId?: unknown;
  action?: unknown;
  goalId?: unknown;
  snoozeUntil?: unknown;
};

const VALID_ACTIONS: InboxCommandAction[] = [
  "archive",
  "snooze",
  "unsnooze",
  "favorite",
  "unfavorite",
  "mark_unread",
  "mark_read",
];

function buildUpsertInput(
  inboxItemId: string,
  action: InboxCommandAction,
  goalId: string | undefined,
  snoozeUntil: string | undefined,
): UpsertInboxItemStateInput {
  const base: UpsertInboxItemStateInput = { inboxItemId, goalId };
  switch (action) {
    case "archive":
      return { ...base, status: "archived" };
    case "snooze":
      return { ...base, status: "snoozed", snoozeUntil: snoozeUntil ?? null };
    case "unsnooze":
      return { ...base, status: "active", snoozeUntil: null };
    case "favorite":
      return { ...base, favorite: true };
    case "unfavorite":
      return { ...base, favorite: false };
    case "mark_unread":
      return { ...base, unread: true };
    case "mark_read":
      return { ...base, unread: false };
  }
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as Body;
  const inboxItemId = typeof body.inboxItemId === "string" ? body.inboxItemId.trim() : "";
  const action = typeof body.action === "string" ? (body.action as InboxCommandAction) : null;

  if (!inboxItemId) {
    return NextResponse.json({ ok: false, reason: "缺少 inboxItemId" }, { status: 400 });
  }
  if (!action || !VALID_ACTIONS.includes(action)) {
    return NextResponse.json({ ok: false, reason: "无效的 action" }, { status: 400 });
  }

  const goalId = typeof body.goalId === "string" && body.goalId.trim() ? body.goalId : undefined;
  const snoozeUntil = typeof body.snoozeUntil === "string" && body.snoozeUntil.trim() ? body.snoozeUntil : undefined;

  try {
    const state = upsertInboxItemState(buildUpsertInput(inboxItemId, action, goalId, snoozeUntil));
    return NextResponse.json({ ok: true, state });
  } catch {
    return NextResponse.json({ ok: false, reason: "inbox 命令执行失败" }, { status: 500 });
  }
}

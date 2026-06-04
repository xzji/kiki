"use client";

import type { InboxItem, InboxItemState } from "@/types/kiki";

export type InboxCommandAction =
  | "archive"
  | "snooze"
  | "unsnooze"
  | "favorite"
  | "unfavorite"
  | "mark_unread"
  | "mark_read";

export async function fetchInboxItemStates(): Promise<InboxItemState[]> {
  const response = await fetch("/api/inbox/state", { method: "GET" });
  if (!response.ok) return [];
  const data = (await response.json().catch(() => ({}))) as { states?: InboxItemState[] };
  return Array.isArray(data.states) ? data.states : [];
}

export async function fetchInboxBootstrap(): Promise<{ states: InboxItemState[]; items: InboxItem[] }> {
  const response = await fetch("/api/inbox/state", { method: "GET" });
  if (!response.ok) return { states: [], items: [] };
  const data = (await response.json().catch(() => ({}))) as {
    states?: InboxItemState[];
    items?: InboxItem[];
  };
  return {
    states: Array.isArray(data.states) ? data.states : [],
    items: Array.isArray(data.items) ? data.items : [],
  };
}

export async function sendInboxCommand(input: {
  inboxItemId: string;
  action: InboxCommandAction;
  goalId?: string;
  snoozeUntil?: string;
}): Promise<InboxItemState | null> {
  const response = await fetch("/api/inbox/commands", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) return null;
  const data = (await response.json().catch(() => ({}))) as { state?: InboxItemState };
  return data.state ?? null;
}

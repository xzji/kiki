"use client";

import { create } from "zustand";

import { sendInboxCommand } from "@/lib/api/inbox-commands";
import type { InboxItem, InboxItemState } from "@/types/kiki";

type InboxStore = {
  items: InboxItem[];
  snoozedItems: InboxItem[];
  historyItems: InboxItem[];
  /** inboxItemId -> 用户操作状态覆盖层（来自后端 inbox_item_states）。 */
  stateMap: Record<string, InboxItemState>;
  markRead: (id: string) => void;
  markUnread: (id: string) => void;
  markTaskRead: (taskId: string) => void;
  removeItem: (id: string) => void;
  archiveItem: (id: string) => void;
  snoozeItem: (id: string) => void;
  unsnoozeItem: (id: string) => void;
  toggleFavorite: (id: string) => void;
  addItem: (item: InboxItem) => void;
  upsertItem: (item: InboxItem) => void;
  hydrateStates: (states: InboxItemState[]) => void;
};

const BUCKETS = ["items", "snoozedItems", "historyItems"] as const;
type BucketKey = (typeof BUCKETS)[number];

function findItemById(state: InboxStore, id: string): InboxItem | undefined {
  for (const bucket of BUCKETS) {
    const found = state[bucket].find((item) => item.id === id);
    if (found) return found;
  }
  return undefined;
}

function removeFromAllBuckets(state: InboxStore, id: string) {
  return {
    items: state.items.filter((item) => item.id !== id),
    snoozedItems: state.snoozedItems.filter((item) => item.id !== id),
    historyItems: state.historyItems.filter((item) => item.id !== id),
  };
}

function bucketForStatus(status: InboxItemState["status"]): BucketKey {
  if (status === "snoozed") return "snoozedItems";
  if (status === "archived") return "historyItems";
  return "items";
}

function statusForBucket(bucket: BucketKey): InboxItemState["status"] {
  if (bucket === "snoozedItems") return "snoozed";
  if (bucket === "historyItems") return "archived";
  return "active";
}

function locateItem(state: InboxStore, id: string): { item: InboxItem; bucket: BucketKey } | null {
  for (const bucket of BUCKETS) {
    const item = state[bucket].find((entry) => entry.id === id);
    if (item) return { item, bucket };
  }
  return null;
}

/**
 * 计算并写回该卡片的覆盖层状态：以当前所在桶/卡片字段为基线，叠加本次操作 patch。
 * 保持 stateMap 为投影的单一权威源，防止事件重投影复活/重置已处理卡片。
 */
function withOverlay(
  state: InboxStore,
  id: string,
  patch: Partial<InboxItemState>,
): Record<string, InboxItemState> {
  const located = locateItem(state, id);
  const existing = state.stateMap[id];
  const base: InboxItemState = {
    inboxItemId: id,
    goalId: located?.item.goalId ?? existing?.goalId,
    status: located ? statusForBucket(located.bucket) : existing?.status ?? "active",
    favorite: located?.item.favorite ?? existing?.favorite ?? false,
    unread: located ? located.item.unreadCount > 0 : existing?.unread ?? true,
  };
  return { ...state.stateMap, [id]: { ...base, ...patch } };
}

export const useInboxStore = create<InboxStore>((set, get) => ({
  items: [],
  snoozedItems: [],
  historyItems: [],
  stateMap: {},

  markRead: (id) => {
    set((state) => {
      const update = (list: InboxItem[]) =>
        list.map((item) => (item.id === id ? { ...item, unreadCount: 0 } : item));
      return {
        items: update(state.items),
        snoozedItems: update(state.snoozedItems),
        stateMap: withOverlay(state, id, { unread: false }),
      };
    });
    void sendInboxCommand({ inboxItemId: id, action: "mark_read" });
  },

  markUnread: (id) => {
    set((state) => {
      const update = (list: InboxItem[]) =>
        list.map((item) => (item.id === id ? { ...item, unreadCount: 1 } : item));
      return {
        items: update(state.items),
        snoozedItems: update(state.snoozedItems),
        stateMap: withOverlay(state, id, { unread: true }),
      };
    });
    void sendInboxCommand({ inboxItemId: id, action: "mark_unread" });
  },

  markTaskRead: (taskId) =>
    set((state) => ({
      items: state.items.map((item) =>
        item.linkTo.match(/tasks\/([^?]+)/)?.[1] === taskId ? { ...item, unreadCount: 0 } : item,
      ),
    })),

  removeItem: (id) => set((state) => removeFromAllBuckets(state, id)),

  archiveItem: (id) => {
    let goalId: string | undefined;
    set((state) => {
      const target = findItemById(state, id);
      if (!target) return state;
      goalId = target.goalId ?? state.stateMap[id]?.goalId;
      const rest = removeFromAllBuckets(state, id);
      return {
        ...rest,
        historyItems: [{ ...target, unreadCount: 0 }, ...rest.historyItems],
        stateMap: withOverlay(state, id, { status: "archived", unread: false }),
      };
    });
    void sendInboxCommand({ inboxItemId: id, action: "archive", goalId });
  },

  snoozeItem: (id) => {
    let goalId: string | undefined;
    set((state) => {
      const target = findItemById(state, id);
      if (!target) return state;
      goalId = target.goalId ?? state.stateMap[id]?.goalId;
      const rest = removeFromAllBuckets(state, id);
      return {
        ...rest,
        snoozedItems: [target, ...rest.snoozedItems],
        stateMap: withOverlay(state, id, { status: "snoozed" }),
      };
    });
    void sendInboxCommand({ inboxItemId: id, action: "snooze", goalId });
  },

  unsnoozeItem: (id) => {
    let goalId: string | undefined;
    set((state) => {
      const target = findItemById(state, id);
      if (!target) return state;
      goalId = target.goalId ?? state.stateMap[id]?.goalId;
      const rest = removeFromAllBuckets(state, id);
      return {
        ...rest,
        items: [target, ...rest.items],
        stateMap: withOverlay(state, id, { status: "active" }),
      };
    });
    void sendInboxCommand({ inboxItemId: id, action: "unsnooze", goalId });
  },

  toggleFavorite: (id) => {
    const current = findItemById(get(), id);
    const nextFavorite = !current?.favorite;
    set((state) => {
      const update = (list: InboxItem[]) =>
        list.map((item) => (item.id === id ? { ...item, favorite: nextFavorite } : item));
      return {
        items: update(state.items),
        snoozedItems: update(state.snoozedItems),
        historyItems: update(state.historyItems),
        stateMap: withOverlay(state, id, { favorite: nextFavorite }),
      };
    });
    void sendInboxCommand({ inboxItemId: id, action: nextFavorite ? "favorite" : "unfavorite" });
  },

  addItem: (item) =>
    set((state) => (findItemById(state, item.id) ? state : { items: [item, ...state.items] })),

  upsertItem: (item) =>
    set((state) => {
      // 叠加用户操作覆盖层：决定该卡片落在哪个桶，并应用 favorite/unread。
      const override = state.stateMap[item.id];
      const targetBucket: BucketKey = override ? bucketForStatus(override.status) : "items";
      const merged: InboxItem = {
        ...item,
        favorite: override ? override.favorite : item.favorite,
        unreadCount: override ? (override.unread ? 1 : 0) : item.unreadCount,
      };
      const rest = removeFromAllBuckets(state, item.id);
      return { ...rest, [targetBucket]: [merged, ...rest[targetBucket]] };
    }),

  hydrateStates: (states) =>
    set((state) => {
      const stateMap: Record<string, InboxItemState> = {};
      for (const entry of states) stateMap[entry.inboxItemId] = entry;

      // 收集所有已知 item，按最新覆盖层重新分桶。
      const all = [...state.items, ...state.snoozedItems, ...state.historyItems];
      const seen = new Set<string>();
      const next: Record<BucketKey, InboxItem[]> = { items: [], snoozedItems: [], historyItems: [] };
      for (const item of all) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        const override = stateMap[item.id];
        const bucket = override ? bucketForStatus(override.status) : "items";
        next[bucket].push({
          ...item,
          favorite: override ? override.favorite : item.favorite,
          unreadCount: override ? (override.unread ? 1 : 0) : item.unreadCount,
        });
      }
      return { stateMap, items: next.items, snoozedItems: next.snoozedItems, historyItems: next.historyItems };
    }),
}));

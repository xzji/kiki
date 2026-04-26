import { sleep } from "@/lib/utils";
import { useInboxStore } from "@/stores/inboxStore";

export async function getInboxItems() {
  await sleep();
  return useInboxStore.getState().items;
}

export async function getHistoryItems() {
  await sleep();
  return useInboxStore.getState().historyItems;
}

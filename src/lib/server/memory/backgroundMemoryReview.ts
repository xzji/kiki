import { promoteStableUserMemoryCandidates } from "@/lib/server/memory/userMemoryPromotionService";

const MIN_REVIEW_INTERVAL_MS = 10 * 60 * 1000;

const lastReviewByUser = new Map<string, number>();

export function maybeRunBackgroundMemoryReview(input: { userId: string }) {
  const now = Date.now();
  const last = lastReviewByUser.get(input.userId) ?? 0;
  if (now - last < MIN_REVIEW_INTERVAL_MS) return { scheduled: false, reason: "throttled" };
  lastReviewByUser.set(input.userId, now);

  void promoteStableUserMemoryCandidates().catch((error) => {
    console.error("background memory review failed", error);
  });
  return { scheduled: true };
}

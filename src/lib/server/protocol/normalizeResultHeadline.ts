import { isOverlappingDisplayText, stripNotificationPrefix } from "@/lib/protocol/displayText";
import type { TaskResultNotificationDecision } from "@/types/kiki";

export function normalizeResultHeadline<T extends TaskResultNotificationDecision>(
  decision: T,
  extraCanonicals?: Array<string | undefined>,
): T {
  const snippet = stripNotificationPrefix(decision.snippet);
  if (!snippet) return decision;
  const candidates = [decision.resultSummary.headline, ...(extraCanonicals ?? [])]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  const overlapped = candidates.some((candidate) => isOverlappingDisplayText(snippet, candidate));
  if (!overlapped) return decision;
  return {
    ...decision,
    snippet: "",
  };
}

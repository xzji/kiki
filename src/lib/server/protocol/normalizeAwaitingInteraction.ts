import { isOverlappingDisplayText, isSameDisplayText, stripNotificationPrefix } from "@/lib/protocol/displayText";
import type { InteractionRequirement, TaskInstanceAwaitingUser } from "@/types/kiki";

function emptyDuplicateQuestion(question: string | undefined, canonical: string) {
  if (!question?.trim() || !canonical.trim()) return question ?? "";
  return isOverlappingDisplayText(question, canonical) ? "" : question;
}

export function normalizeInteractionRequirement(
  requirement: InteractionRequirement | undefined,
): InteractionRequirement | undefined {
  if (!requirement) return requirement;
  const canonical = requirement.question?.trim() || requirement.reason.trim();
  return {
    ...requirement,
    fields: requirement.fields?.map((field) => ({
      ...field,
      question: emptyDuplicateQuestion(field.question, canonical),
    })),
  };
}

export function normalizeAwaitingInteraction(awaitingUser: TaskInstanceAwaitingUser): TaskInstanceAwaitingUser {
  const interactionRequirement = normalizeInteractionRequirement(awaitingUser.interactionRequirement);
  const canonical =
    interactionRequirement?.question?.trim() ||
    interactionRequirement?.reason.trim() ||
    awaitingUser.reason.trim();
  // 仅在 reason 与 canonical 严格相等时去掉 reason 上的通知前缀；
  // 包含关系（reason 比 canonical 长且额外含信息）保留原 reason，避免丢上下文。
  const strippedReason = stripNotificationPrefix(awaitingUser.reason);
  const reason = canonical && isSameDisplayText(strippedReason, canonical)
    ? strippedReason || awaitingUser.reason
    : awaitingUser.reason;

  return {
    ...awaitingUser,
    reason,
    interactionRequirement,
    blocker: awaitingUser.blocker
      ? {
          ...awaitingUser.blocker,
          interactionRequirement:
            normalizeInteractionRequirement(awaitingUser.blocker.interactionRequirement) ??
            awaitingUser.blocker.interactionRequirement,
        }
      : awaitingUser.blocker,
  };
}

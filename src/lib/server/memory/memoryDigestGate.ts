const MIN_DIGEST_TEXT_LENGTH = 200;
const MIN_DIGEST_TURN_GAP = 3;
const MIN_DIGEST_INTERVAL_MS = 60 * 1000;

type DigestGateState = {
  lastTurn: number;
  lastAt: number;
};

const stateByConversation = new Map<string, DigestGateState>();
const turnByConversation = new Map<string, number>();

const EXPLICIT_MEMORY_PATTERN = /(记住|以后都|我的偏好是|请记住|后续都|以后请)/;

function isShortSmallTalk(value: string) {
  const text = value.trim().toLowerCase();
  return /^(hi|hello|hey|你好|您好|哈喽|在吗|ok|好的|嗯|哦|谢谢|谢了)[。！!.\s]*$/.test(text);
}

export function shouldRunMemoryDigest(input: {
  conversationId: string;
  userMessage: string;
  assistantText: string;
  aborted: boolean;
  force?: boolean;
}) {
  if (input.aborted) return { shouldRun: false, reason: "aborted" };
  if (!input.assistantText.trim()) return { shouldRun: false, reason: "missing_final_text" };

  const currentTurn = (turnByConversation.get(input.conversationId) ?? 0) + 1;
  turnByConversation.set(input.conversationId, currentTurn);

  const explicitMemory = EXPLICIT_MEMORY_PATTERN.test(input.userMessage);
  if (input.force) {
    stateByConversation.set(input.conversationId, { lastTurn: currentTurn, lastAt: Date.now() });
    return { shouldRun: true, reason: "forced", explicitMemoryIntent: explicitMemory };
  }
  if (!explicitMemory && isShortSmallTalk(input.userMessage)) {
    return { shouldRun: false, reason: "short_smalltalk" };
  }
  if (!explicitMemory && `${input.userMessage}\n${input.assistantText}`.trim().length < MIN_DIGEST_TEXT_LENGTH) {
    return { shouldRun: false, reason: "text_too_short" };
  }

  const now = Date.now();
  const last = stateByConversation.get(input.conversationId);
  if (!explicitMemory && last) {
    const turnGap = currentTurn - last.lastTurn;
    const timeGap = now - last.lastAt;
    if (turnGap < MIN_DIGEST_TURN_GAP || timeGap < MIN_DIGEST_INTERVAL_MS) {
      return { shouldRun: false, reason: "throttled" };
    }
  }

  stateByConversation.set(input.conversationId, { lastTurn: currentTurn, lastAt: now });
  return {
    shouldRun: true,
    reason: explicitMemory ? "explicit_memory" : "eligible",
    explicitMemoryIntent: explicitMemory,
  };
}

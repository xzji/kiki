export function shouldShowTaskCardMeta(input: { inlineResultVisible: boolean }) {
  return !input.inlineResultVisible;
}

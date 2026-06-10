import type { Conversation } from "@/types/kiki";

type StartInstantConversationEntryInput = {
  createConversation: () => Conversation;
  ensureConversationWorkspace: (conversationId: string) => Promise<string>;
  navigate: (href: string) => void;
  setConversationWorkspace: (conversationId: string, workspacePath: string) => void;
  setConversationBackgroundIssue: (
    conversationId: string,
    issue: Conversation["backgroundIssue"],
  ) => void;
  now?: () => Date;
};

export function startInstantConversationEntry(input: StartInstantConversationEntryInput) {
  const next = input.createConversation();
  const now = input.now ?? (() => new Date());

  void input.ensureConversationWorkspace(next.id)
    .then((workspacePath) => input.setConversationWorkspace(next.id, workspacePath))
    .catch((error) => {
      input.setConversationBackgroundIssue(next.id, {
        kind: "workspace",
        message: error instanceof Error ? error.message : "会话 workspace 初始化失败，可稍后重试。",
        occurredAt: now().toISOString(),
        retryable: true,
      });
    });

  input.navigate(`/conversations/${next.id}`);
  return next;
}

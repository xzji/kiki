import type { Conversation, Goal } from "@/types/kiki";

export async function ensureConversationWorkspaceApi(conversationId: string) {
  const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/workspace`, {
    method: "POST",
  });
  const data = (await response.json()) as {
    ok: boolean;
    workspaceDir?: string;
    reason?: string;
  };
  if (!response.ok || !data.ok || !data.workspaceDir) {
    throw new Error(data.reason || "初始化会话 workspace 失败");
  }
  return data.workspaceDir;
}

export async function deleteConversationWorkspaceApi(input: {
  conversationId: string;
  claudeSessionId?: string;
}) {
  const response = await fetch(`/api/conversations/${encodeURIComponent(input.conversationId)}/workspace`, {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      claudeSessionId: input.claudeSessionId,
    }),
  });
  const data = (await response.json()) as {
    ok: boolean;
    reason?: string;
    cancelledJobs?: number;
    deletedJobs?: number;
    deletedClaudeSession?: boolean;
  };
  if (!response.ok || !data.ok) {
    throw new Error(data.reason || "删除会话 workspace 失败");
  }
  return data;
}

export async function writeConversationContextApi(input: {
  conversation: Conversation;
  goal?: Goal | null;
}) {
  const response = await fetch(
    `/api/conversations/${encodeURIComponent(input.conversation.id)}/workspace/context`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    },
  );
  const data = (await response.json()) as {
    ok: boolean;
    reason?: string;
  };
  if (!response.ok || !data.ok) {
    throw new Error(data.reason || "写入会话上下文失败");
  }
  return data;
}

import type { Conversation, ConversationMessage, Goal } from "@/types/dora";

/**
 * 将 goals 拍平为会话：
 * - 每个 goal 生成 1 个会话，会话 id = `conv-${goalId}`
 * - 每个 task.instance 生成 1 条 task_card 消息
 * - chat_history 类型 goal 会额外注入 chatTurns
 */
export function buildConversationsFromGoals(goals: Goal[]): Conversation[] {
  return goals.map((goal) => {
    const messages: ConversationMessage[] = [];

    // chat_history 类型：把 chatTurns 转成 text
    if (goal.kind === "chat_history" && goal.chatTurns?.length) {
      for (const turn of goal.chatTurns) {
        messages.push({
          id: `msg-${turn.id}`,
          kind: "text",
          role: turn.role === "agent" ? "kiki" : "user",
          content: turn.content,
          createdAt: turn.timestamp,
          unread: false,
        });
      }
    }

    // collab / digest：把每个 instance 拍平为 task_card
    for (const subGoal of goal.subGoals) {
      for (const task of subGoal.tasks) {
        for (const instance of task.instances) {
          const unread =
            instance.status === "pending" || instance.status === "awaiting_user";
          messages.push({
            id: `msg-${instance.id}`,
            kind: "task_card",
            role: "kiki",
            content: instance.intro,
            createdAt: instance.createdAt,
            unread,
            taskRef: {
              goalId: goal.id,
              subGoalId: subGoal.id,
              taskId: task.id,
              instanceId: instance.id,
            },
          });
        }
      }
    }

    // 按时间升序（对话从上到下显示最早在上）
    messages.sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt));

    const latest = messages[messages.length - 1];
    const updatedAt = latest?.createdAt ?? goal.createdAt;

    return {
      id: `conv-${goal.id}`,
      title: goal.title,
      goalId: goal.id,
      messages,
      updatedAt,
    };
  });
}

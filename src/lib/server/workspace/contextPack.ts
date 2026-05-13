import type { ExecutionTrajectoryStep } from "@/types/executionTrajectory";
import type { Conversation, ConversationMessage, Goal, SubGoal, Task, TaskInstance } from "@/types/kiki";

function truncate(value: string, max = 1200) {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...`;
}

function messageRoleLabel(role: ConversationMessage["role"]) {
  if (role === "user") return "用户";
  return "KiKi";
}

export function serializeConversationMessages(messages: ConversationMessage[]) {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    kind: message.kind,
  }));
}

function formatTask(task: Task) {
  const latestInstance = task.instances[task.instances.length - 1];
  return `- ${task.title}：${task.description || task.expectedOutcome || "无描述"}${latestInstance ? `（状态：${latestInstance.status}）` : ""}`;
}

export function buildConversationContextPack(input: {
  conversation: Conversation;
  goal?: Goal | null;
  recentMessages: ConversationMessage[];
  quotedMessage?: { roleLabel: string; content: string } | null;
}) {
  const lines: string[] = [
    "# 当前会话上下文",
    "",
    "## 边界规则",
    "- 你是 KiKi 当前会话助手，不是代码仓库开发助手。",
    "- 只能依据当前会话上下文和当前工作目录内的文件回答。",
    "- 不得读取父目录、项目源码目录或其他会话 workspace。",
    "- 如果用户要求继续/恢复，但当前上下文没有可恢复状态，请说明当前会话没有找到可恢复任务。",
    "",
    "## 会话信息",
    `- conversationId: ${input.conversation.id}`,
    `- title: ${input.conversation.title}`,
    `- status: ${input.conversation.status || "idle"}`,
  ];

  if (input.conversation.planningRunState) {
    lines.push(
      "",
      "## 目标规划恢复状态",
      `- phase: ${input.conversation.planningRunState.phase}`,
      `- action: ${input.conversation.planningRunState.action}`,
      `- error: ${input.conversation.planningRunState.errorMessage}`,
      `- goalText: ${input.conversation.planningRunState.goalText}`,
    );
  }

  if (input.goal) {
    lines.push("", "## 当前目标", `- title: ${input.goal.title}`, `- summary: ${input.goal.summary || ""}`);
    input.goal.subGoals.forEach((subGoal) => {
      lines.push("", `### 子目标：${subGoal.title}`, ...(subGoal.tasks.slice(0, 8).map(formatTask)));
    });
  }

  if (input.quotedMessage) {
    lines.push("", "## 用户引用消息", `[${input.quotedMessage.roleLabel}] ${truncate(input.quotedMessage.content)}`);
  }

  lines.push("", "## 最近会话消息");
  input.recentMessages.slice(-12).forEach((message) => {
    lines.push(`- ${messageRoleLabel(message.role)}（${message.createdAt}）：${truncate(message.content, 800)}`);
  });

  return `${lines.join("\n")}\n`;
}

export function buildTaskContextPack(input: {
  goal: Goal;
  subGoal: SubGoal;
  task: Task;
  instance: TaskInstance;
  trajectory?: ExecutionTrajectoryStep[];
  resumeContext?: string;
}) {
  const lines = [
    "# 当前任务上下文",
    "",
    "## 边界规则",
    "- 你只能处理当前任务 workspace 内的文件。",
    "- 不得访问父目录、项目源码目录或其他会话 workspace。",
    "",
    "## 目标",
    `- ${input.goal.title}`,
    input.goal.summary ? `- ${input.goal.summary}` : "",
    "",
    "## 子目标",
    `- ${input.subGoal.title}`,
    input.subGoal.description ? `- ${input.subGoal.description}` : "",
    "",
    "## 任务",
    `- title: ${input.task.title}`,
    `- description: ${input.task.description}`,
    `- expectedOutcome: ${input.task.expectedOutcome}`,
    `- instanceId: ${input.instance.id}`,
  ].filter(Boolean);

  if (input.resumeContext?.trim()) {
    lines.push("", "## 恢复上下文", input.resumeContext.trim());
  }
  if (input.trajectory?.length) {
    lines.push("", "## 已有执行轨迹摘要");
    input.trajectory.slice(-20).forEach((step) => {
      lines.push(`- ${step.status}：${step.title}${step.thought ? ` / ${truncate(step.thought, 300)}` : ""}`);
    });
  }

  return `${lines.join("\n")}\n`;
}

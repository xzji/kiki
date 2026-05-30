import type { Conversation, ConversationMessage, Goal, Task } from "@/types/kiki";
import type { QuotedConversationMessageContext } from "@/types/runtime";

function truncate(value: string, max = 1200) {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...`;
}

const TERMINAL_CONTROL_NOTICE_PATTERNS = [
  /^\s*（已停止，未检测到正在运行的任务）\s*$/gm,
  /^\s*已停止，未检测到正在运行的任务。\s*$/gm,
];

export function sanitizeConversationMessageContent(content: string) {
  return TERMINAL_CONTROL_NOTICE_PATTERNS.reduce(
    (next, pattern) => next.replace(pattern, ""),
    content,
  )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Prompt 可见的最小消息投影。仅保留 prompt 拼装与落盘必需的字段，
 * 显式丢弃 `id`、`taskRef`、`taskSnapshot`、`structured`、`source`、`status` 等内部字段。
 */
export type PromptSafeMessage = {
  role: ConversationMessage["role"];
  content: string;
  createdAt: string;
  kind: ConversationMessage["kind"];
};

export function sanitizeConversationMessages(messages: ConversationMessage[]): PromptSafeMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: sanitizeConversationMessageContent(message.content),
    createdAt: message.createdAt,
    kind: message.kind,
  }));
}

function messageRoleLabel(role: ConversationMessage["role"]) {
  if (role === "user") return "用户";
  return "KiKi";
}

// ─────────────────────────────────────────────────────────────────────────────
// 模型上下文边界（Model Context Boundary）— 统一脱敏过滤层
// 仅作用于 Class A（用户对话）路径：会话主对话 + workspace context.md 落盘。
// Class B（任务执行 / goal planning）路径必须保留 taskId/instanceId 等契约字段，
// 不应使用本节函数对契约 ID 进行抹除。
// ─────────────────────────────────────────────────────────────────────────────

const INTERNAL_ID_PATTERN = /\b(?:conv|goal|sub|task|inst)-[A-Za-z0-9_-]+/g;

/**
 * 抹除 KiKi 内部 ID（conv-*、goal-*、sub-*、task-*、inst-* 形式）。
 * 仅用于 Class A 用户对话路径，避免模型在用户气泡中复述内部主键。
 */
export function redactInternalIdentifiers(value: string) {
  if (!value) return value;
  return value.replace(INTERNAL_ID_PATTERN, "<redacted-id>");
}

/**
 * 把 ISO 时间戳转成"YYYY-MM-DD HH:mm"形式，避免模型复述毫秒时间戳。
 * 解析失败时回退原值。
 */
export function formatTimestampForModel(iso: string) {
  if (!iso) return iso;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const yyyy = date.getFullYear();
  const mm = `${date.getMonth() + 1}`.padStart(2, "0");
  const dd = `${date.getDate()}`.padStart(2, "0");
  const hh = `${date.getHours()}`.padStart(2, "0");
  const min = `${date.getMinutes()}`.padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

const PHASE_LABEL: Record<string, string> = {
  intent: "目标意图收集",
  goal_review: "目标审阅",
  subgoal_review: "子目标审阅",
  planning: "计划生成",
  finalize: "最终确认",
};

const ACTION_LABEL: Record<string, string> = {
  awaiting_user: "等待用户补充信息",
  running: "运行中",
  failed: "执行失败",
  paused: "暂停",
  completed: "已完成",
};

/**
 * 把 planningRunState 翻译成自然语言短句，避免把 errorMessage 原始堆栈、
 * 内部 phase/action 字段名暴露给模型。
 */
export function buildSafePlanningRunStateLine(
  state: NonNullable<Conversation["planningRunState"]>,
): string {
  const phase = state.phase ? PHASE_LABEL[state.phase] || "目标规划" : "目标规划";
  const action = state.action ? ACTION_LABEL[state.action] || "处理中" : "处理中";
  const segments = [`上一次目标规划处于「${phase}」阶段，状态为「${action}」`];
  if (state.errorMessage) {
    segments.push("上一次执行因系统异常中断（错误细节已隐藏）");
  }
  if (state.goalText) {
    segments.push(`目标文本：${truncate(state.goalText, 400)}`);
  }
  return segments.join("；");
}

/**
 * 仅保留 roleLabel + content（脱敏）。彻底丢弃 taskRef 内部 ID 与 messageId。
 */
export function serializeQuotedMessageForModel(quoted: QuotedConversationMessageContext) {
  return {
    roleLabel: quoted.roleLabel,
    content: redactInternalIdentifiers(truncate(quoted.content)),
  };
}

function formatTask(task: PromptSafeTask) {
  const latestInstance = task.instances[task.instances.length - 1];
  return `- ${task.title}：${task.description || task.expectedOutcome || "无描述"}${latestInstance ? `（状态：${latestInstance.status}）` : ""}`;
}

/**
 * Prompt 可见的最小 Conversation 投影。仅保留 prompt 拼装所需字段。
 * 显式丢弃 `id`、`goalId`、`workspacePath`、`claudeSessionId`、`runtimeEnvId`、`pinned` 等内部字段。
 */
export type PromptSafeConversation = {
  title: string;
  status?: Conversation["status"];
  planningRunState?: Conversation["planningRunState"];
  messages: PromptSafeMessage[];
};

export type PromptSafeTaskInstance = {
  status: Task["instances"][number]["status"];
};

export type PromptSafeTask = {
  title: string;
  description: string;
  expectedOutcome: string;
  instances: PromptSafeTaskInstance[];
};

export type PromptSafeSubGoal = {
  title: string;
  tasks: PromptSafeTask[];
};

export type PromptSafeGoal = {
  title: string;
  summary?: string;
  subGoals: PromptSafeSubGoal[];
};

export function pickConversationForPrompt(conversation: Conversation): PromptSafeConversation {
  return {
    title: conversation.title,
    status: conversation.status,
    planningRunState: conversation.planningRunState,
    messages: sanitizeConversationMessages(conversation.messages),
  };
}

export function pickGoalForPrompt(goal: Goal): PromptSafeGoal {
  return {
    title: goal.title,
    summary: goal.summary,
    subGoals: goal.subGoals.map((subGoal) => ({
      title: subGoal.title,
      tasks: subGoal.tasks.map((task) => ({
        title: task.title,
        description: task.description,
        expectedOutcome: task.expectedOutcome,
        instances: task.instances.map((instance) => ({ status: instance.status })),
      })),
    })),
  };
}

export function buildConversationContextPack(input: {
  conversation: PromptSafeConversation;
  goal?: PromptSafeGoal | null;
  recentMessages: PromptSafeMessage[];
  quotedMessage?: QuotedConversationMessageContext | null;
}) {
  const lines: string[] = [
    "# 当前会话上下文",
    "",
    "## 边界规则",
    "- 你是 KiKi 当前会话助手，不是代码仓库开发助手。",
    "- 只能依据当前会话上下文和当前工作目录内的文件回答。",
    "- 不得读取父目录、项目源码目录或其他会话 workspace。",
    "- 如果用户要求继续/恢复，但当前上下文没有可恢复状态，请说明当前会话没有找到可恢复任务。",
  ];

  if (input.conversation.planningRunState) {
    lines.push(
      "",
      "## 目标规划恢复状态",
      `- ${buildSafePlanningRunStateLine(input.conversation.planningRunState)}`,
    );
  }

  if (input.goal) {
    lines.push(
      "",
      "## 当前目标",
      `- title: ${input.goal.title}`,
      `- summary: ${input.goal.summary || ""}`,
    );
    input.goal.subGoals.forEach((subGoal) => {
      lines.push(
        "",
        `### 子目标：${subGoal.title}`,
        ...subGoal.tasks.slice(0, 8).map(formatTask),
      );
    });
  }

  if (input.quotedMessage) {
    const quoted = serializeQuotedMessageForModel(input.quotedMessage);
    lines.push("", "## 用户引用消息", `[${quoted.roleLabel}] ${quoted.content}`);
  }

  lines.push("", "## 最近会话消息");
  input.recentMessages.slice(-12).forEach((message) => {
    lines.push(
      `- ${messageRoleLabel(message.role)}（${formatTimestampForModel(message.createdAt)}）：${redactInternalIdentifiers(
        truncate(sanitizeConversationMessageContent(message.content), 800),
      )}`,
    );
  });

  lines.push(
    "",
    "## 注意",
    "以上为系统提供的语境，不要在回复中复述系统字段名（如 conversationId、goalId、taskId 等）或任何内部 ID。",
  );

  // 最终对整个 context pack 文本执行一次内部 ID 抹除作为深度防御。
  return `${redactInternalIdentifiers(lines.join("\n"))}\n`;
}

// 注意：原 buildTaskContextPack 已移除（dead code，无任何调用方）。
// 任务执行 Agent 走 buildGoalTaskRunnerPrompt 路径（Class B），
// 该路径需要保留 taskId/instanceId 作为 task_result 回填契约。

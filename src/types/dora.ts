export type TaskInstanceStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "awaiting_user";

export type ExecutionKind =
  | "flashcard"
  | "listening_qa"
  | "reading_digest"
  | "confirm_action"
  | "draft_review"
  | "freeform_chat";

export type FlashCard = {
  id: string;
  word: string;
  phonetic: string;
  partOfSpeech: string;
  meaning: string;
  examples: { en: string; zh: string }[];
};

export type QA = {
  id: string;
  question: string;
  options: string[];
  answerIndex: number;
  explanation: string;
};

export type Article = {
  id: string;
  title: string;
  source: string;
  summary: string;
  body: string;
};

export type EmailDraft = {
  id: string;
  recipient: string;
  subject: string;
  body: string;
};

export type ExecutionPayload =
  | { kind: "flashcard"; cards: FlashCard[] }
  | { kind: "listening_qa"; audioUrl: string; questions: QA[] }
  | { kind: "reading_digest"; articles: Article[] }
  | { kind: "confirm_action"; summary: string; options: string[] }
  | { kind: "draft_review"; drafts: EmailDraft[] }
  | { kind: "freeform_chat"; seed: string };

export type TaskInstance = {
  id: string;
  taskId: string;
  dateLabel: string;
  status: TaskInstanceStatus;
  intro: string;
  payload: ExecutionPayload;
  createdAt: string;
};

export type Task = {
  id: string;
  subGoalId: string;
  title: string;
  description: string;
  expectedOutcome: string;
  taskType: "daily_repeat" | "one_shot" | "monitoring";
  triggerRule: string;
  deadline?: string;
  progress: number;
  instances: TaskInstance[];
  executionKind: ExecutionKind;
};

export type SubGoal = {
  id: string;
  goalId: string;
  title: string;
  tasks: Task[];
};

export type Goal = {
  id: string;
  title: string;
  deadline: string;
  progress: number;
  subGoals: SubGoal[];
  createdAt: string;
};

export type InboxItem = {
  id: string;
  iconType: "task" | "mail" | "news" | "booking";
  title: string;
  snippet: string;
  badge?: "need_answer" | "need_confirm" | null;
  unreadCount: number;
  timeLabel: string;
  linkTo: string;
  goalId?: string;
  createdAt: string;
};

export type DoraMessage = {
  id: string;
  role: "dora" | "user";
  content: string;
  timestamp: string;
  taskInstanceId?: string;
};

export type GoalBreakdownDraft = {
  goalTitle: string;
  subGoals: {
    id: string;
    title: string;
    tasks: {
      id: string;
      title: string;
      description: string;
      expectedOutcome: string;
      taskType: Task["taskType"];
      triggerRule: string;
      executionKind: ExecutionKind;
    }[];
  }[];
};

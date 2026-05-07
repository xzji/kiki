import { emailDrafts } from "@/mocks/emails";
import { flashcards } from "@/mocks/flashcards";
import { newsArticles } from "@/mocks/news";
import type {
  ExecutionKind,
  ExecutionPayload,
  Goal,
  GoalBreakdownDraft,
  Task,
  TaskInstance,
} from "@/types/dora";

export const INITIAL_NOW = "2026-04-26T10:00:00+08:00";

function payloadFor(kind: ExecutionKind): ExecutionPayload {
  switch (kind) {
    case "flashcard":
      return { kind, cards: flashcards };
    case "listening_qa":
      return {
        kind,
        audioUrl: "/audio/listening.mp3",
        questions: [
          {
            id: "qa-1",
            question: "What is the man mainly doing?",
            options: ["Driving a car", "Putting on a seatbelt", "Fixing the engine", "Washing the car"],
            answerIndex: 1,
            explanation: "The dialogue points to the man fastening his seatbelt before departure.",
          },
          {
            id: "qa-2",
            question: "Why does the professor mention the telescope?",
            options: [
              "To describe a museum exhibit",
              "To explain how data was collected",
              "To compare two planets",
              "To invite students to a lab tour",
            ],
            answerIndex: 1,
            explanation: "The telescope is referenced as the instrument used to gather evidence.",
          },
        ],
      };
    case "reading_digest":
      return { kind, articles: newsArticles };
    case "confirm_action":
      return {
        kind,
        summary: "已为你选定 5 月 3 日 13:42 大阪→京都，JR 特急，¥2380，可免费改签一次。",
        options: ["确认执行", "让 Kiki 改方案"],
      };
    case "draft_review":
      return { kind, drafts: emailDrafts };
    case "freeform_chat":
      return { kind, seed: "我会继续基于你的长期目标，把下一步拆成更具体的行动。" };
  }
}

function instance(
  id: string,
  taskId: string,
  dateLabel: string,
  createdAt: string,
  intro: string,
  kind: ExecutionKind,
  status: TaskInstance["status"] = "pending",
): TaskInstance {
  return { id, taskId, dateLabel, status, intro, payload: payloadFor(kind), createdAt };
}

function task(data: Omit<Task, "instances"> & { instances?: TaskInstance[] }): Task {
  return { ...data, instances: data.instances ?? [] };
}

export const initialGoals: Goal[] = [
  {
    id: "goal-toefl",
    title: "托福考试 110 分",
    deadline: "2026-05-01T23:59:59+08:00",
    progress: 59,
    createdAt: "2026-03-01T09:00:00+08:00",
    subGoals: [
      {
        id: "sg-toefl-reading",
        goalId: "goal-toefl",
        title: "子目标1：提高阅读分数到 29-30 分",
        tasks: [
          task({
            id: "task-toefl-vocab",
            subGoalId: "sg-toefl-reading",
            title: "任务1：核心学术词汇扫荡",
            description: "每天记忆 100-150 个托福高频词汇，以天体生态科学、天文、地质学等学科词为主。",
            expectedOutcome: "完成 2000 个托福词汇的学习",
            taskType: "daily_repeat",
            triggerRule: "每天 11:00 触发",
            deadline: "2026-05-01T23:59:59+08:00",
            progress: 16,
            executionKind: "flashcard",
            instances: [
              instance("inst-vocab-0426", "task-toefl-vocab", "04-26", "2026-04-26T11:00:00+08:00", "今天先从天文场景高频词开始。我整理了 30 张卡片，先做一轮快速记忆，再把易错词标出来。", "flashcard", "pending"),
              instance("inst-vocab-0425", "task-toefl-vocab", "04-25", "2026-04-25T11:00:00+08:00", "昨天你在天体类词汇里还不够稳定，今天的卡片我补了两条近义辨析。", "flashcard", "completed"),
              instance("inst-vocab-0401", "task-toefl-vocab", "04-01", "2026-04-01T11:00:00+08:00", "开学第一轮词汇训练已经开始，先把 lecture 高频词建立熟悉感。", "flashcard", "completed"),
            ],
          }),
          task({
            id: "task-toefl-note",
            subGoalId: "sg-toefl-reading",
            title: "任务2：逻辑结构拆解练习",
            description: "对每篇学术材料做一页 note-taking 复盘，保留因果-解释-例证主线。",
            expectedOutcome: "每周完成 5 份逻辑结构图",
            taskType: "daily_repeat",
            triggerRule: "每天 15:00 触发",
            progress: 32,
            executionKind: "freeform_chat",
          }),
          task({
            id: "task-toefl-listening",
            subGoalId: "sg-toefl-reading",
            title: "任务3：限时听力精听分析",
            description: "选取 1-2 篇 lecture 材料做精听，边听边定位中文含义。",
            expectedOutcome: "提升听力正确率到 85% 以上",
            taskType: "daily_repeat",
            triggerRule: "每天 11:00 触发",
            progress: 48,
            executionKind: "listening_qa",
            instances: [
              instance("inst-listen-0426", "task-toefl-listening", "04-26", "2026-04-26T11:00:00+08:00", "昨天听力题目，你已经答对了 9 道题（共 10 题），正确率为 90%。今天我把难度提高了一点，重点看天文类材料。", "listening_qa", "awaiting_user"),
              instance("inst-listen-0425", "task-toefl-listening", "04-25", "2026-04-25T11:00:00+08:00", "昨天的校园场景题你做得比较稳，今天尝试跨到 lecture 场景。", "listening_qa", "completed"),
              instance("inst-listen-0424", "task-toefl-listening", "04-24", "2026-04-24T11:00:00+08:00", "这组题里需要重点抓教授给出的转折提示词，我帮你把错题整理在最后了。", "listening_qa", "completed"),
            ],
          }),
        ],
      },
      {
        id: "sg-toefl-speaking",
        goalId: "goal-toefl",
        title: "子目标2：提高听力能力到 29-30 分",
        tasks: [
          task({
            id: "task-toefl-shadow",
            subGoalId: "sg-toefl-speaking",
            title: "任务1：影子跟读",
            description: "练习 15 分钟 shadowing，建立语音块感。",
            expectedOutcome: "压缩反应时间和听感疲劳。",
            taskType: "daily_repeat",
            triggerRule: "每天 08:30 触发",
            progress: 64,
            executionKind: "freeform_chat",
          }),
          task({
            id: "task-toefl-summary",
            subGoalId: "sg-toefl-speaking",
            title: "任务2：lecture 摘要复述",
            description: "复述 lecture 的因果链条与教授态度。",
            expectedOutcome: "输出 3 段高质量复述。",
            taskType: "daily_repeat",
            triggerRule: "每天 20:00 触发",
            progress: 40,
            executionKind: "freeform_chat",
          }),
          task({
            id: "task-toefl-digest",
            subGoalId: "sg-toefl-speaking",
            title: "任务3：阅读素材精读",
            description: "用短篇科普新闻补充背景知识，减少陌生主题负担。",
            expectedOutcome: "每周完成 6 篇精读材料",
            taskType: "monitoring",
            triggerRule: "每天 09:00 触发",
            progress: 51,
            executionKind: "reading_digest",
          }),
        ],
      },
    ],
  },
  {
    id: "goal-suv",
    title: "购买 SUV 汽车",
    deadline: "2026-06-15T23:59:59+08:00",
    progress: 34,
    createdAt: "2026-04-02T10:00:00+08:00",
    subGoals: [{ id: "sg-suv-1", goalId: "goal-suv", title: "子目标1：确定车型与预算", tasks: [task({ id: "task-suv-compare", subGoalId: "sg-suv-1", title: "任务1：候选车型对比", description: "每晚更新一轮参数和试驾反馈。", expectedOutcome: "保留 2 款最终候选车型。", taskType: "monitoring", triggerRule: "每天 19:00 触发", progress: 52, executionKind: "confirm_action" })] }],
  },
  {
    id: "goal-osaka",
    title: "大阪 6 日游",
    deadline: "2026-05-03T23:59:59+08:00",
    progress: 72,
    createdAt: "2026-03-20T10:00:00+08:00",
    subGoals: [{ id: "sg-osaka-1", goalId: "goal-osaka", title: "子目标1：完成交通与住宿预订", tasks: [task({ id: "task-osaka-ticket", subGoalId: "sg-osaka-1", title: "任务1：购买大阪到京都车票", description: "确定车次、座位和改签策略。", expectedOutcome: "成功预订一张最合适的车票。", taskType: "one_shot", triggerRule: "今天 12:00 触发", progress: 90, executionKind: "confirm_action", instances: [instance("inst-osaka-0410", "task-osaka-ticket", "04-10", "2026-04-10T09:00:00+08:00", "我筛选了 3 班从大阪到京都的车次，优先保留了换乘少、到站时间更宽松的方案。", "confirm_action", "awaiting_user")] })] }],
  },
  {
    id: "goal-mail",
    title: "邮件",
    deadline: "2026-04-30T23:59:59+08:00",
    progress: 66,
    createdAt: "2026-04-05T10:00:00+08:00",
    subGoals: [{ id: "sg-mail-1", goalId: "goal-mail", title: "子目标1：清理待发送邮件", tasks: [task({ id: "task-mail-review", subGoalId: "sg-mail-1", title: "任务1：邮件草稿审阅", description: "确认 3 封待发邮件的语气、结构和下一步动作。", expectedOutcome: "完成 3 封邮件发送。", taskType: "daily_repeat", triggerRule: "每天 16:00 触发", progress: 70, executionKind: "draft_review", instances: [instance("inst-mail-0401", "task-mail-review", "04-01", "2026-04-01T09:00:00+08:00", "我帮你草拟了 3 封待发送邮件，先从最关键的面试确认邮件开始。", "draft_review", "awaiting_user")] })] }],
  },
  {
    id: "goal-news",
    title: "今日要闻",
    deadline: "2026-04-30T23:59:59+08:00",
    progress: 80,
    createdAt: "2026-04-01T08:00:00+08:00",
    subGoals: [{ id: "sg-news-1", goalId: "goal-news", title: "子目标1：跟进 AI 方向的重要动态", tasks: [task({ id: "task-news-digest", subGoalId: "sg-news-1", title: "任务1：AI 行业新闻", description: "阅读并标记 3 篇和 Agent 相关的重要新闻。", expectedOutcome: "输出一份简短摘要供晚间复盘。", taskType: "daily_repeat", triggerRule: "每天 09:00 触发", progress: 86, executionKind: "reading_digest", instances: [instance("inst-news-0426", "task-news-digest", "04-26", "2026-04-26T09:00:00+08:00", "整理了 4 条 AI 行业的关键信息，OpenAI 发布多智能体协作框架位列第一。", "reading_digest", "awaiting_user")] })] }],
  },
  {
    id: "goal-job",
    title: "找 AI 产品经理工作",
    deadline: "2026-06-01T23:59:59+08:00",
    progress: 28,
    createdAt: "2026-04-06T08:00:00+08:00",
    subGoals: [{ id: "sg-job-1", goalId: "goal-job", title: "子目标1：建立投递节奏", tasks: [task({ id: "task-job-rehearsal", subGoalId: "sg-job-1", title: "任务1：岗位表述 rehearse", description: "和 Kiki 练习一句话介绍、项目亮点和 why now。", expectedOutcome: "形成一版简练的面试开场脚本。", taskType: "daily_repeat", triggerRule: "每天 20:30 触发", progress: 28, executionKind: "freeform_chat" })] }],
  },
];

export function buildGoalFromDraft(draft: GoalBreakdownDraft): Goal {
  const goalId = `goal-${draft.goalTitle.replace(/\s+/g, "-").toLowerCase()}`;
  return {
    id: goalId,
    title: draft.goalTitle,
    deadline: "2026-06-30T23:59:59+08:00",
    progress: 0,
    createdAt: INITIAL_NOW,
    subGoals: draft.subGoals.map((subGoal, subGoalIndex) => ({
      id: `${goalId}-sg-${subGoalIndex + 1}`,
      goalId,
      title: subGoal.title,
      tasks: subGoal.tasks.map((taskItem, taskIndex) => ({
        id: `${goalId}-task-${taskIndex + 1}`,
        subGoalId: `${goalId}-sg-${subGoalIndex + 1}`,
        title: taskItem.title,
        description: taskItem.description,
        expectedOutcome: taskItem.expectedOutcome,
        taskType: taskItem.taskType,
        triggerRule: taskItem.triggerRule,
        deadline: "2026-06-30T23:59:59+08:00",
        progress: 0,
        instances: [],
        executionKind: taskItem.executionKind,
      })),
    })),
  };
}

export function createGeneratedInstance(task: Task, createdAt: string): TaskInstance {
  const date = new Date(createdAt);
  const dateLabel = `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return {
    id: `${task.id}-${dateLabel}`,
    taskId: task.id,
    dateLabel,
    status: "pending",
    intro: `到了 ${task.triggerRule} 的触发时间，我已经为你准备好“${task.title.replace(/^任务\d+：/, "") }”的今日内容。`,
    payload: payloadFor(task.executionKind),
    createdAt,
  };
}

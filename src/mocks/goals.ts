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
        options: ["确认执行", "让 KiKi 改方案"],
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
    kind: "collab",
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
    kind: "collab",
    subGoals: [
      {
        id: "sg-suv-budget",
        goalId: "goal-suv",
        title: "子目标1：确定预算与候选车型",
        tasks: [
          task({
            id: "task-suv-budget",
            subGoalId: "sg-suv-budget",
            title: "任务1：明确购车预算与用车场景",
            description: "盘点首付能力、月供上限、家庭用车场景（城市通勤/郊游/长途）与核心诉求。",
            expectedOutcome: "一份购车预算表（总价区间、首付、月供、保险 5 项）+ 一句话用车定位",
            taskType: "one_shot",
            triggerRule: "今天 21:00 触发",
            progress: 100,
            executionKind: "freeform_chat",
            instances: [
              instance("inst-suv-budget-0410", "task-suv-budget", "04-10", "2026-04-10T21:00:00+08:00", "我整理了你最近 3 个月的现金流和家庭用车场景，初步定在 25–35 万区间，以城市为主、偶尔长途。", "freeform_chat", "completed"),
            ],
          }),
          task({
            id: "task-suv-compare",
            subGoalId: "sg-suv-budget",
            title: "任务2：候选车型对比",
            description: "每晚更新一轮参数和试驾反馈，覆盖合资、新势力、传统豪华 3 个阵营。",
            expectedOutcome: "保留 2 款最终候选车型，附对比表（价格/空间/智驾/用车成本）",
            taskType: "monitoring",
            triggerRule: "每天 19:00 触发",
            progress: 52,
            executionKind: "confirm_action",
          }),
          task({
            id: "task-suv-review",
            subGoalId: "sg-suv-budget",
            title: "任务3：真实车主口碑调研",
            description: "每天读 5 条懂车帝/汽车之家/小红书真实车主点评，提炼高频吐槽。",
            expectedOutcome: "一份车主口碑摘要（每款 5 条正面 + 5 条吐槽）",
            taskType: "daily_repeat",
            triggerRule: "每天 22:00 触发",
            progress: 40,
            executionKind: "reading_digest",
          }),
        ],
      },
      {
        id: "sg-suv-testdrive",
        goalId: "goal-suv",
        title: "子目标2：线下看车与试驾",
        tasks: [
          task({
            id: "task-suv-appointment",
            subGoalId: "sg-suv-testdrive",
            title: "任务1：预约试驾",
            description: "根据候选车型，联系最近 3 家 4S 店预约周末试驾时段。",
            expectedOutcome: "确认至少 2 个试驾预约（含门店地址、时间、销售联系方式）",
            taskType: "one_shot",
            triggerRule: "周五 10:00 触发",
            progress: 20,
            executionKind: "confirm_action",
          }),
          task({
            id: "task-suv-testdrive-checklist",
            subGoalId: "sg-suv-testdrive",
            title: "任务2：试驾评测清单",
            description: "每次试驾前推送标准化评测清单（NVH、辅助驾驶、底盘调校、智能座舱）。",
            expectedOutcome: "每辆车一份试驾打分表（10 个维度 × 1–5 分）",
            taskType: "one_shot",
            triggerRule: "试驾当天 08:30 触发",
            progress: 10,
            executionKind: "draft_review",
          }),
        ],
      },
      {
        id: "sg-suv-deal",
        goalId: "goal-suv",
        title: "子目标3：成交与上牌",
        tasks: [
          task({
            id: "task-suv-negotiate",
            subGoalId: "sg-suv-deal",
            title: "任务1：议价策略准备",
            description: "结合近 30 天成交价、月末冲量节奏和置换补贴，列出谈判底线与目标价。",
            expectedOutcome: "一份议价话术 + 目标价/底价两个档位",
            taskType: "one_shot",
            triggerRule: "5 月第二周周日 20:00 触发",
            progress: 0,
            executionKind: "freeform_chat",
          }),
          task({
            id: "task-suv-insurance",
            subGoalId: "sg-suv-deal",
            title: "任务2：保险与上牌方案",
            description: "对比 3 家保险公司首年报价，梳理临牌、上牌预约、过户等流程。",
            expectedOutcome: "最终保险方案（含保费）+ 上牌时间线",
            taskType: "one_shot",
            triggerRule: "成交当天 21:00 触发",
            progress: 0,
            executionKind: "confirm_action",
          }),
        ],
      },
    ],
  },
  {
    id: "goal-osaka",
    title: "大阪 6 日游",
    deadline: "2026-05-03T23:59:59+08:00",
    progress: 72,
    createdAt: "2026-03-20T10:00:00+08:00",
    kind: "collab",
    subGoals: [
      {
        id: "sg-osaka-plan",
        goalId: "goal-osaka",
        title: "子目标1：行程规划与预订",
        tasks: [
          task({
            id: "task-osaka-flight",
            subGoalId: "sg-osaka-plan",
            title: "任务1：机票与签证",
            description: "比价 3 家航司的往返机票，确认签证有效期与办理进度。",
            expectedOutcome: "确认往返机票 + 签证可出行",
            taskType: "one_shot",
            triggerRule: "4 月第三周周日 20:00 触发",
            progress: 100,
            executionKind: "confirm_action",
            instances: [
              instance("inst-osaka-flight-0415", "task-osaka-flight", "04-15", "2026-04-15T20:00:00+08:00", "我比了 3 家航司的往返组合，最终选定了周六出发、次周四返程的吉祥航空直飞。", "confirm_action", "completed"),
            ],
          }),
          task({
            id: "task-osaka-hotel",
            subGoalId: "sg-osaka-plan",
            title: "任务2：酒店与民宿预订",
            description: "按照大阪 3 晚 + 京都 2 晚 + 神户 1 晚的安排锁定住宿。",
            expectedOutcome: "6 晚住宿全部确认（含确认号、入住时间、取消政策）",
            taskType: "one_shot",
            triggerRule: "4 月第四周周一 20:00 触发",
            progress: 85,
            executionKind: "confirm_action",
          }),
          task({
            id: "task-osaka-ticket",
            subGoalId: "sg-osaka-plan",
            title: "任务3：购买大阪到京都车票",
            description: "确定车次、座位和改签策略。",
            expectedOutcome: "成功预订一张最合适的车票。",
            taskType: "one_shot",
            triggerRule: "今天 12:00 触发",
            progress: 90,
            executionKind: "confirm_action",
            instances: [
              instance("inst-osaka-0410", "task-osaka-ticket", "04-10", "2026-04-10T09:00:00+08:00", "我筛选了 3 班从大阪到京都的车次，优先保留了换乘少、到站时间更宽松的方案。", "confirm_action", "awaiting_user"),
            ],
          }),
        ],
      },
      {
        id: "sg-osaka-itinerary",
        goalId: "goal-osaka",
        title: "子目标2：每日行程与美食",
        tasks: [
          task({
            id: "task-osaka-daily",
            subGoalId: "sg-osaka-itinerary",
            title: "任务1：每日行程推送",
            description: "出行前一晚自动推送明日路线、预约时间、交通票据与预计步行距离。",
            expectedOutcome: "6 份每日行程卡（每天一张，含早中晚 3 个锚点）",
            taskType: "daily_repeat",
            triggerRule: "出行期间每晚 21:00 触发",
            progress: 60,
            executionKind: "reading_digest",
          }),
          task({
            id: "task-osaka-food",
            subGoalId: "sg-osaka-itinerary",
            title: "任务2：美食与餐厅预订",
            description: "筛选 6 家目标餐厅，提前 1–3 天确认是否需要在线预约。",
            expectedOutcome: "一份美食清单（6 家餐厅 + 预约状态）",
            taskType: "monitoring",
            triggerRule: "每天 10:00 触发",
            progress: 70,
            executionKind: "confirm_action",
          }),
        ],
      },
      {
        id: "sg-osaka-wrap",
        goalId: "goal-osaka",
        title: "子目标3：回程收尾",
        tasks: [
          task({
            id: "task-osaka-reimburse",
            subGoalId: "sg-osaka-wrap",
            title: "任务1：回程清单与退税",
            description: "整理购物小票、退税单据，准备机场退税动线。",
            expectedOutcome: "退税清单（含每笔金额、店铺、所需单据）",
            taskType: "one_shot",
            triggerRule: "5 月 2 日 20:00 触发",
            progress: 10,
            executionKind: "draft_review",
          }),
          task({
            id: "task-osaka-recap",
            subGoalId: "sg-osaka-wrap",
            title: "任务2：行程复盘与游记",
            description: "回国后一起回顾这次旅行，沉淀一篇图文游记。",
            expectedOutcome: "一篇 1500 字游记 + 精选 20 张照片",
            taskType: "one_shot",
            triggerRule: "5 月 4 日 20:00 触发",
            progress: 0,
            executionKind: "freeform_chat",
          }),
        ],
      },
    ],
  },
  {
    id: "goal-mail",
    title: "邮件",
    deadline: "2026-04-30T23:59:59+08:00",
    progress: 66,
    createdAt: "2026-04-05T10:00:00+08:00",
    kind: "digest",
    summary: "每天在你固定的写邮件时段，KiKi 把待发邮件整理好草稿，等你 10 分钟内完成审阅与发送。",
    subGoals: [{ id: "sg-mail-1", goalId: "goal-mail", title: "子目标1：清理待发送邮件", tasks: [task({ id: "task-mail-review", subGoalId: "sg-mail-1", title: "任务1：邮件草稿审阅", description: "确认 3 封待发邮件的语气、结构和下一步动作。", expectedOutcome: "完成 3 封邮件发送。", taskType: "daily_repeat", triggerRule: "每天 16:00 触发", progress: 70, executionKind: "draft_review", instances: [instance("inst-mail-0401", "task-mail-review", "04-01", "2026-04-01T09:00:00+08:00", "我帮你草拟了 3 封待发送邮件，先从最关键的面试确认邮件开始。", "draft_review", "awaiting_user")] })] }],
  },
  {
    id: "goal-news",
    title: "今日要闻",
    deadline: "2026-04-30T23:59:59+08:00",
    progress: 80,
    createdAt: "2026-04-01T08:00:00+08:00",
    kind: "digest",
    summary: "每天早晨 9 点，KiKi 汇总昨晚到今早的 AI 行业重要动态，给你一份可速读的摘要。",
    subGoals: [{ id: "sg-news-1", goalId: "goal-news", title: "子目标1：跟进 AI 方向的重要动态", tasks: [task({ id: "task-news-digest", subGoalId: "sg-news-1", title: "任务1：AI 行业新闻", description: "阅读并标记 3 篇和 Agent 相关的重要新闻。", expectedOutcome: "输出一份简短摘要供晚间复盘。", taskType: "daily_repeat", triggerRule: "每天 09:00 触发", progress: 86, executionKind: "reading_digest", instances: [instance("inst-news-0426", "task-news-digest", "04-26", "2026-04-26T09:00:00+08:00", "整理了 4 条 AI 行业的关键信息，OpenAI 发布多智能体协作框架位列第一。", "reading_digest", "awaiting_user")] })] }],
  },
  {
    id: "goal-job",
    title: "找 AI 产品经理工作",
    deadline: "2026-06-01T23:59:59+08:00",
    progress: 28,
    createdAt: "2026-04-06T08:00:00+08:00",
    kind: "collab",
    subGoals: [
      {
        id: "sg-job-positioning",
        goalId: "goal-job",
        title: "子目标1：岗位定位与素材准备",
        tasks: [
          task({
            id: "task-job-role",
            subGoalId: "sg-job-positioning",
            title: "任务1：岗位画像拆解",
            description: "梳理目标岗位（AI PM / Agent PM）的核心职责、能力要求和代表性公司。",
            expectedOutcome: "一份 1 页岗位画像摘要（3 类岗位 × 5 项能力要求）",
            taskType: "one_shot",
            triggerRule: "今天 20:00 触发",
            progress: 80,
            executionKind: "reading_digest",
          }),
          task({
            id: "task-job-resume",
            subGoalId: "sg-job-positioning",
            title: "任务2：简历与案例库",
            description: "沉淀 5 个可复用的产品项目案例，覆盖从 0→1、AI 增强、规模化 3 类。",
            expectedOutcome: "一版面向 AI PM 的中英文简历 + 5 个 STAR 项目卡",
            taskType: "daily_repeat",
            triggerRule: "每天 21:00 触发",
            progress: 45,
            executionKind: "draft_review",
          }),
          task({
            id: "task-job-rehearsal",
            subGoalId: "sg-job-positioning",
            title: "任务3：岗位表述 rehearse",
            description: "和 KiKi 练习一句话介绍、项目亮点和 why now。",
            expectedOutcome: "一份精炼的面试开场脚本（30 秒自我介绍 + 3 个项目亮点）",
            taskType: "daily_repeat",
            triggerRule: "每天 20:30 触发",
            progress: 28,
            executionKind: "freeform_chat",
          }),
        ],
      },
      {
        id: "sg-job-deliver",
        goalId: "goal-job",
        title: "子目标2：投递与面试执行",
        tasks: [
          task({
            id: "task-job-list",
            subGoalId: "sg-job-deliver",
            title: "任务1：投递节奏确认",
            description: "和 KiKi 一起决定本周要投递的公司清单、内推人与投递渠道。",
            expectedOutcome: "每周一份投递计划表（5–10 家公司 × 渠道 × 截止日）",
            taskType: "monitoring",
            triggerRule: "每周日 20:00 触发",
            progress: 20,
            executionKind: "confirm_action",
          }),
          task({
            id: "task-job-interview",
            subGoalId: "sg-job-deliver",
            title: "任务2：模拟面试",
            description: "围绕项目经历做 20 分钟口述演练，覆盖产品思维题与场景题。",
            expectedOutcome: "每次面试一份复盘笔记（亮点 + 暴露的 3 个问题）",
            taskType: "daily_repeat",
            triggerRule: "每天 11:00 触发",
            progress: 15,
            executionKind: "freeform_chat",
          }),
          task({
            id: "task-job-mail",
            subGoalId: "sg-job-deliver",
            title: "任务3：邮件与感谢信",
            description: "检查投递邮件、跟进邮件和面试感谢信。",
            expectedOutcome: "3 个邮件模板 + 每场面试 24 小时内完成感谢信",
            taskType: "daily_repeat",
            triggerRule: "每天 18:00 触发",
            progress: 30,
            executionKind: "draft_review",
          }),
        ],
      },
      {
        id: "sg-job-offer",
        goalId: "goal-job",
        title: "子目标3：复盘与 Offer 谈判",
        tasks: [
          task({
            id: "task-job-recap",
            subGoalId: "sg-job-offer",
            title: "任务1：面试复盘库",
            description: "把每一轮面试的问题、答题结构、暴露的短板归档到复盘库。",
            expectedOutcome: "一份面试复盘库（按题型分类 + 20 道高频题的答法）",
            taskType: "daily_repeat",
            triggerRule: "每天 22:30 触发",
            progress: 10,
            executionKind: "freeform_chat",
          }),
          task({
            id: "task-job-offer",
            subGoalId: "sg-job-offer",
            title: "任务2：Offer 谈判准备",
            description: "拿到意向后，对比现金、股权、成长空间，准备谈判话术。",
            expectedOutcome: "一份 Offer 对比表 + 3 种谈判剧本（基础/中等/挑战）",
            taskType: "one_shot",
            triggerRule: "拿到首个 offer 当晚 21:00 触发",
            progress: 0,
            executionKind: "freeform_chat",
          }),
        ],
      },
    ],
  },
  {
    id: "goal-tomato-egg",
    title: "西红柿炒鸡蛋怎么做",
    deadline: "2026-04-10T23:59:59+08:00",
    progress: 100,
    createdAt: "2026-04-08T18:20:00+08:00",
    kind: "chat_history",
    summary: "一次和 KiKi 的简单对话，咨询了一道家常菜的做法。",
    subGoals: [],
    chatTurns: [
      {
        id: "chat-1",
        role: "user",
        content: "西红柿炒鸡蛋怎么做？",
        timestamp: "2026-04-08T18:20:12+08:00",
      },
      {
        id: "chat-2",
        role: "agent",
        content:
          "给你一个简单又好吃的版本：\n\n1. 2 个西红柿去蒂切块，3 个鸡蛋加一小撮盐打散。\n2. 热锅凉油，倒入蛋液，略凝固时用筷子划散，盛出备用。\n3. 原锅加一点油，下西红柿中小火翻炒出汁，加 1 茶匙糖、半茶匙盐。\n4. 倒回鸡蛋快速翻炒 30 秒，撒点葱花出锅。\n\n小 tip：想要汤汁多可以盖盖子焖 1 分钟，拌饭也很香。",
        timestamp: "2026-04-08T18:20:35+08:00",
      },
      {
        id: "chat-3",
        role: "user",
        content: "可以不放糖吗？",
        timestamp: "2026-04-08T18:21:02+08:00",
      },
      {
        id: "chat-4",
        role: "agent",
        content:
          "可以。糖主要是用来中和西红柿的酸味，让味道更圆润。如果你用的西红柿本身就比较甜，或者喜欢酸爽一点的口感，可以不放；也可以换成一小勺番茄酱，同样能让味道更柔和。",
        timestamp: "2026-04-08T18:21:18+08:00",
      },
    ],
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
    kind: "collab",
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

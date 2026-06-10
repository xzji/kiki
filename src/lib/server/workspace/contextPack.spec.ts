import assert from "node:assert/strict";

import { buildWorkspaceBoundPrompt, buildWorkspaceSystemPrompt } from "@/lib/server/claude/transport";
import {
  buildConversationContextPack,
  buildSafePlanningRunStateLine,
  formatTimestampForModel,
  pickConversationForPrompt,
  pickGoalForPrompt,
  redactInternalIdentifiers,
  sanitizeConversationMessages,
  serializeQuotedMessageForModel,
} from "@/lib/server/workspace/contextPack";
import type { Conversation, ConversationMessage, Goal } from "@/types/kiki";
import type { QuotedConversationMessageContext } from "@/types/runtime";

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "conv-test-001",
    title: "测试会话",
    status: "idle",
    messages: [],
    createdAt: "2026-05-30T12:34:56.789Z",
    updatedAt: "2026-05-30T12:34:56.789Z",
    ...overrides,
  } as Conversation;
}

function makeGoal(): Goal {
  return {
    id: "goal-test-001",
    conversationId: "conv-test-001",
    title: "学好越南语",
    summary: "在 6 个月内能进行日常交流",
    subGoals: [
      {
        id: "sub-test-001",
        title: "掌握基础词汇",
        description: "",
        tasks: [
          {
            id: "task-test-001",
            title: "学习 200 个高频词",
            description: "通过 Anki 卡片记忆",
            expectedOutcome: "能识别并书写 200 个高频词",
            instances: [
              {
                id: "inst-test-001",
                status: "running",
              } as unknown as never,
            ],
          } as unknown as never,
        ],
      } as unknown as never,
    ],
    createdAt: "2026-05-30T12:34:56.789Z",
    updatedAt: "2026-05-30T12:34:56.789Z",
  } as unknown as Goal;
}

function makeMessage(overrides: Partial<ConversationMessage> = {}): ConversationMessage {
  return {
    id: "msg-001",
    role: "user",
    kind: "user_message",
    content: "你好",
    createdAt: "2026-05-30T12:34:56.789Z",
    ...overrides,
  } as ConversationMessage;
}

export function runContextPackBoundarySpecs() {
  // 1) redactInternalIdentifiers 抹除内部 ID 前缀
  {
    const input = "请查看 conv-abc123、goal-test-001 和 task-test-001 的状态。";
    const output = redactInternalIdentifiers(input);
    assert.ok(!/conv-abc123/.test(output), "conv- 应被抹除");
    assert.ok(!/goal-test-001/.test(output), "goal- 应被抹除");
    assert.ok(!/task-test-001/.test(output), "task- 应被抹除");
    assert.ok(/<redacted-id>/.test(output), "应使用 <redacted-id> 占位");
  }

  // 2) formatTimestampForModel 把 ISO 毫秒戳转成 YYYY-MM-DD HH:mm
  {
    const formatted = formatTimestampForModel("2026-05-30T12:34:56.789Z");
    assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(formatted), `应是 YYYY-MM-DD HH:mm，实际：${formatted}`);
    assert.ok(!/\.789Z/.test(formatted), "毫秒不应出现");
  }

  // 3) buildSafePlanningRunStateLine 不暴露原始 errorMessage
  {
    const line = buildSafePlanningRunStateLine({
      status: "failed",
      phase: "goal_review" as never,
      action: "failed" as never,
      goalText: "学好越南语",
      errorMessage:
        "Error: spawn ENOENT at /Users/bytedance/Documents/trae/long_horizon_agent/cli\n  at process.handle",
      failedAt: "2026-05-30T12:34:56.789Z",
      updatedAt: "2026-05-30T12:34:56.789Z",
    });
    assert.ok(!/Error:/.test(line), "不应包含 Error: 关键词");
    assert.ok(!/\/Users\//.test(line), "不应包含绝对路径");
    assert.ok(!/ENOENT/.test(line), "不应包含原始错误码");
    assert.ok(/系统异常中断/.test(line), "应给出语义化错误描述");
  }

  // 4) serializeQuotedMessageForModel 丢弃 taskRef
  {
    const quoted: QuotedConversationMessageContext = {
      roleLabel: "KiKi",
      content: "完成了 task-test-001 的子目标分解",
      messageId: "msg-xyz",
      taskRef: {
        goalId: "goal-test-001",
        subGoalId: "sub-test-001",
        taskId: "task-test-001",
        instanceId: "inst-test-001",
      },
    };
    const serialized = serializeQuotedMessageForModel(quoted);
    const json = JSON.stringify(serialized);
    assert.ok(!/taskRef/.test(json), "taskRef 必须被丢弃");
    assert.ok(!/messageId/.test(json), "messageId 必须被丢弃");
    assert.ok(!/task-test-001/.test(json), "taskId 字面值应被抹除");
    assert.ok(!/goal-test-001/.test(json), "goalId 字面值应被抹除");
    assert.equal(serialized.roleLabel, "KiKi");
  }

  // 5) buildConversationContextPack 输出不含任何内部 ID 字面值
  {
    const conversation = makeConversation({
      id: "conv-test-001",
      planningRunState: {
        status: "failed",
        phase: "goal_review" as never,
        action: "failed" as never,
        goalText: "学好越南语",
        errorMessage: "Error: spawn ENOENT at /Users/bytedance/.../cli",
        failedAt: "2026-05-30T12:34:56.789Z",
        updatedAt: "2026-05-30T12:34:56.789Z",
      },
      messages: [
        makeMessage({
          id: "msg-001",
          role: "user",
          content: "请确认 task-test-001 的进度",
          createdAt: "2026-05-30T12:34:56.789Z",
        }),
        makeMessage({
          id: "msg-002",
          role: "kiki",
          content: "好的",
          createdAt: "2026-05-30T12:35:00.000Z",
        }),
      ],
    });
    const pack = buildConversationContextPack({
      conversation: pickConversationForPrompt(conversation),
      goal: pickGoalForPrompt(makeGoal()),
      recentMessages: sanitizeConversationMessages(conversation.messages),
      quotedMessage: {
        roleLabel: "KiKi",
        content: "上一轮完成了 task-test-001",
        taskRef: {
          goalId: "goal-test-001",
          subGoalId: "sub-test-001",
          taskId: "task-test-001",
          instanceId: "inst-test-001",
        },
      },
    });

    // 5a) 不含 conversationId/goalId/taskId/instanceId/subGoalId 这些字段名做"key: value"形式
    assert.ok(!/^- conversationId:/m.test(pack), "不得出现 conversationId: 字段行");
    assert.ok(!/^- status:/m.test(pack), "不得出现 status: 字段行");
    // 5b) 不含 conv-/goal-/sub-/task-/inst- 内部 ID 前缀字面值
    assert.ok(!/conv-test-001/.test(pack), "conv-test-001 不应出现在 pack 中");
    assert.ok(!/goal-test-001/.test(pack), "goal-test-001 不应出现在 pack 中");
    assert.ok(!/sub-test-001/.test(pack), "sub-test-001 不应出现在 pack 中");
    assert.ok(!/task-test-001/.test(pack), "task-test-001 不应出现在 pack 中");
    assert.ok(!/inst-test-001/.test(pack), "inst-test-001 不应出现在 pack 中");
    // 5c) 不含 ISO 毫秒时间戳
    assert.ok(
      !/T\d{2}:\d{2}:\d{2}\.\d{3}Z/.test(pack),
      "ISO 毫秒时间戳不应出现",
    );
    // 5d) 不含 errorMessage 中的 Error:/堆栈
    assert.ok(!/Error: spawn/.test(pack), "原始 errorMessage 不应出现");
    assert.ok(!/\/Users\//.test(pack), "绝对路径不应出现在 pack 中");
    // 5e) quotedMessage.content 仍存在（语义保留）
    assert.ok(/上一轮完成了/.test(pack), "quotedMessage.content 应保留");
    // 5f) goal 标题仍存在
    assert.ok(/学好越南语/.test(pack), "goal.title 应保留");
    // 5g) 边界规则与"不要复述系统字段名"提示存在
    assert.ok(/边界规则/.test(pack), "边界规则段应存在");
    assert.ok(/不要在回复中复述系统字段名/.test(pack), "应有提示禁止复述字段名");
  }

  // 6) 不带 quotedMessage 也能正常生成
  {
    const pack = buildConversationContextPack({
      conversation: pickConversationForPrompt(makeConversation({ id: "conv-bare" })),
      goal: null,
      recentMessages: [],
      quotedMessage: null,
    });
    assert.ok(/边界规则/.test(pack));
    assert.ok(!/conv-bare/.test(pack));
  }

  // 7) buildWorkspaceSystemPrompt strict 模式：workspace basename 形如 conv-xxx 时被 hash 替换
  {
    const prompt = buildWorkspaceSystemPrompt({
      workspaceDir: "/Users/bytedance/Documents/trae/long_horizon_agent/data/conversations/conv-abc-123",
      redactionMode: "strict",
    });
    assert.ok(!/conv-abc-123/.test(prompt), "strict 模式下 conv- basename 应被 hash 替换");
    assert.ok(/isolated-session-[0-9a-f]{8}/.test(prompt), "应使用 isolated-session-<hash> 标签");
    assert.ok(!/\/Users\//.test(prompt), "strict 模式下不应出现 /Users/ 绝对路径");
    assert.ok(/不要在回复中复述系统字段名|禁止复述系统字段名/.test(prompt), "strict 模式应包含禁止复述提示");
  }

  // 8) buildWorkspaceBoundPrompt strict 模式：兜底脱敏覆盖 contextPack 中残留的内部 ID
  {
    const prompt = buildWorkspaceBoundPrompt({
      message: "继续",
      contextPack: "上一次任务 goal-residual 仍在等待 task-residual 完成",
      redactionMode: "strict",
    });
    assert.ok(!/goal-residual/.test(prompt), "strict 兜底应抹除 goal-residual");
    assert.ok(!/task-residual/.test(prompt), "strict 兜底应抹除 task-residual");
    assert.ok(/<redacted-id>/.test(prompt), "strict 兜底应使用 <redacted-id> 占位");
  }

  // 9) buildWorkspaceBoundPrompt passthrough 模式：保留 taskId/instanceId 契约字段（Class B 路径）
  {
    const prompt = buildWorkspaceBoundPrompt({
      message: "execute",
      contextPack: "task_id task-xyz instance inst-zzz",
      redactionMode: "passthrough",
    });
    assert.ok(/task-xyz/.test(prompt), "passthrough 模式应保留 task-xyz 契约字段");
    assert.ok(/inst-zzz/.test(prompt), "passthrough 模式应保留 inst-zzz 契约字段");
    assert.ok(
      !/不要在回复中复述系统字段名|禁止复述系统字段名/.test(prompt),
      "passthrough 模式不应包含 strict 专属的禁止复述提示",
    );
  }

  // 9.1) buildWorkspaceSystemPrompt task 模式：不注入会话身份头，避免与任务 Role 冲突
  {
    const prompt = buildWorkspaceSystemPrompt({
      workspaceDir: "/tmp/conv-xyz",
      workspacePolicy: "task",
      toolSummary: { allowed: ["Read", "Write"], disabled: [] },
      redactionMode: "passthrough",
    });
    assert.ok(/workspaceMode: task/.test(prompt), "task 模式应保留 workspaceMode");
    assert.ok(/已允许：Read、Write/.test(prompt), "task 模式应保留工具策略摘要");
    assert.ok(!/你是 KiKi 当前会话助手/.test(prompt), "task 模式不应注入会话身份头");
    assert.ok(!/不是代码仓库开发助手/.test(prompt), "task 模式不应注入与任务执行冲突的身份约束");
    assert.ok(!/不得读取父目录、项目源码目录/.test(prompt), "task 模式不应注入会话专属源码边界");
  }

  // 9.2) buildWorkspaceSystemPrompt neutral 模式：辅助判官保留脱敏边界，但不注入会话身份
  {
    const prompt = buildWorkspaceSystemPrompt({
      workspaceDir: "/tmp/conv-xyz",
      workspacePolicy: "conversation",
      redactionMode: "strict",
      includeConversationIdentity: false,
    });
    assert.ok(/workspaceMode: conversation/.test(prompt), "neutral 模式应保留 workspaceMode");
    assert.ok(/不要在回复中复述系统字段名|禁止复述系统字段名/.test(prompt), "neutral strict 模式应保留脱敏边界");
    assert.ok(!/你是 KiKi 当前会话助手/.test(prompt), "neutral 模式不应注入会话身份头");
    assert.ok(!/不是代码仓库开发助手/.test(prompt), "neutral 模式不应注入会话身份约束");
  }

  // 10) buildWorkspaceBoundPrompt strict 模式：quotedMessage 不被二次原文注入
  {
    const prompt = buildWorkspaceBoundPrompt({
      message: "继续",
      redactionMode: "strict",
      quotedMessage: {
        roleLabel: "KiKi",
        content: "已完成 task-leaked-id 的执行",
        taskRef: {
          goalId: "goal-leak",
          subGoalId: "sub-leak",
          taskId: "task-leaked-id",
          instanceId: "inst-leak",
        },
      },
    });
    assert.ok(!/task-leaked-id/.test(prompt), "strict 模式下 quotedMessage 中的 task- ID 必须被脱敏");
    assert.ok(!/goal-leak/.test(prompt), "strict 模式下 quotedMessage 中的 goal- ID 必须被脱敏");
  }

  // 11) pickConversationForPrompt 输出对象不含 id/taskRef/structured 等内部字段
  {
    const safe = pickConversationForPrompt(
      makeConversation({
        id: "conv-internal",
        runtimeSessions: { claude: "claude-sess-xxx" },
        workspacePath: "/Users/bytedance/secret/workspace",
        messages: [
          {
            id: "msg-leak",
            role: "kiki",
            kind: "task_card",
            content: "完成",
            createdAt: "2026-05-30T12:34:56.789Z",
            taskRef: {
              goalId: "goal-leak",
              subGoalId: "sub-leak",
              taskId: "task-leak",
              instanceId: "inst-leak",
            },
          } as unknown as ConversationMessage,
        ],
      }),
    );
    const json = JSON.stringify(safe);
    assert.ok(!/"id":/.test(json), "PromptSafeConversation 不应保留 id 字段");
    assert.ok(!/runtimeSessions/.test(json), "不应保留 runtimeSessions");
    assert.ok(!/workspacePath/.test(json), "不应保留 workspacePath");
    assert.ok(!/taskRef/.test(json), "messages 内不应保留 taskRef");
    assert.ok(!/conv-internal/.test(json), "id 字面值不应出现");
  }

  // 12) pickGoalForPrompt 输出对象不含内部 ID 与冗余字段
  {
    const safe = pickGoalForPrompt(makeGoal());
    const json = JSON.stringify(safe);
    assert.ok(!/"id":/.test(json), "PromptSafeGoal 不应保留 id 字段");
    assert.ok(!/conversationId/.test(json), "不应保留 conversationId");
    assert.ok(!/goal-test-001/.test(json), "goal- ID 字面值不应出现");
    assert.ok(!/sub-test-001/.test(json), "sub- ID 字面值不应出现");
    assert.ok(!/task-test-001/.test(json), "task- ID 字面值不应出现");
    assert.ok(/学好越南语/.test(json), "goal.title 应保留");
    assert.ok(/学习 200 个高频词/.test(json), "task.title 应保留");
  }

  // 13) sanitizeConversationMessages 输出不含 id/taskRef/structured 等
  {
    const safe = sanitizeConversationMessages([
      {
        id: "msg-leak",
        role: "kiki",
        kind: "task_card",
        content: "完成",
        createdAt: "2026-05-30T12:34:56.789Z",
        taskRef: {
          goalId: "goal-leak",
          subGoalId: "sub-leak",
          taskId: "task-leak",
          instanceId: "inst-leak",
        },
      } as unknown as ConversationMessage,
    ]);
    const json = JSON.stringify(safe);
    assert.ok(!/"id":/.test(json), "PromptSafeMessage 不应保留 id");
    assert.ok(!/taskRef/.test(json), "PromptSafeMessage 不应保留 taskRef");
    assert.ok(!/msg-leak/.test(json), "msg-leak 字面值不应出现");
    assert.ok(/完成/.test(json), "content 应保留");
  }
}

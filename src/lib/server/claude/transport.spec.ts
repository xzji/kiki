import assert from "node:assert/strict";

import {
  buildWorkspaceSystemPrompt,
  classifyResultError,
  classifySessionFromInitPayload,
  nextCanonicalSessionFromDecision,
  type ClaudeCliPayload,
} from "@/lib/server/claude/transport";

export function runClaudeTransportSessionSpecs() {
  // 1) init 的 session_id 是首个 → 设置为 canonical
  const initFirst = classifySessionFromInitPayload(
    { type: "system", subtype: "init", session_id: "sess-init-1" } as ClaudeCliPayload,
    undefined,
  );
  assert.deepEqual(initFirst, { kind: "set", sessionId: "sess-init-1" });

  // 2) 第二次 init 携带相同 session_id → ignore
  const initSame = classifySessionFromInitPayload(
    { type: "system", subtype: "init", session_id: "sess-init-1" } as ClaudeCliPayload,
    "sess-init-1",
  );
  assert.equal(initSame.kind, "ignore");

  // 3) 第二次 init 携带不同 session_id → duplicate-init（不广播，仅记日志）
  const initDup = classifySessionFromInitPayload(
    { type: "system", subtype: "init", session_id: "sess-init-2" } as ClaudeCliPayload,
    "sess-init-1",
  );
  assert.deepEqual(initDup, { kind: "duplicate-init", ignored: "sess-init-2" });

  // 4) hook_started 携带 session_id → 必须 ignore（绝不能覆盖 canonical）
  const hookStarted = classifySessionFromInitPayload(
    { type: "hook_started", session_id: "hook-session-xyz" } as unknown as ClaudeCliPayload,
    "sess-init-1",
  );
  assert.equal(hookStarted.kind, "ignore");

  // 5) hook_response 携带 session_id → 必须 ignore
  const hookResponse = classifySessionFromInitPayload(
    { type: "hook_response", session_id: "hook-session-xyz" } as unknown as ClaudeCliPayload,
    "sess-init-1",
  );
  assert.equal(hookResponse.kind, "ignore");

  // 6) 普通 result 携带 session_id → 必须 ignore
  const resultPayload = classifySessionFromInitPayload(
    { type: "result", subtype: "success", session_id: "result-session" } as ClaudeCliPayload,
    "sess-init-1",
  );
  assert.equal(resultPayload.kind, "ignore");

  // 7) result.error 包含 "No conversation found with session ID" → session_invalid
  const sessionInvalid = classifyResultError(
    {
      type: "result",
      subtype: "error_during_execution",
      result: "No conversation found with session ID: bad-id",
    } as ClaudeCliPayload,
    "bad-id",
  );
  assert.deepEqual(sessionInvalid, {
    kind: "session_invalid",
    sessionId: "bad-id",
    message: "No conversation found with session ID: bad-id",
  });

  // 8) result.error 但没传 claudeSessionId → 普通 error
  const sessionInvalidWithoutId = classifyResultError(
    {
      type: "result",
      subtype: "error_during_execution",
      result: "No conversation found with session ID: bad-id",
    } as ClaudeCliPayload,
    undefined,
  );
  assert.equal(sessionInvalidWithoutId.kind, "error");

  // 9) result.error 与 session 无关 → 普通 error，使用 result/errors/api_error_status fallback
  const genericError = classifyResultError(
    {
      type: "result",
      subtype: "error_during_execution",
      errors: ["rate limit", "retry"],
    } as ClaudeCliPayload,
    "sess-init-1",
  );
  assert.deepEqual(genericError, { kind: "error", message: "rate limit\nretry" });

  // 10) 全部缺失时使用兜底中文文案
  const fallbackError = classifyResultError(
    { type: "result", subtype: "error_during_execution" } as ClaudeCliPayload,
    "sess-init-1",
  );
  assert.equal(fallbackError.kind, "error");
  assert.equal((fallbackError as { kind: "error"; message: string }).message, "Claude 返回了错误结果");

  // 11) 真实 stream-json 顺序回归：init → hook → assistant/result，只有 init 能锁定 canonical session
  const payloads: ClaudeCliPayload[] = [
    { type: "system", subtype: "init", session_id: "canonical-session" },
    { type: "hook_started", session_id: "hook-started-session" } as unknown as ClaudeCliPayload,
    { type: "hook_response", session_id: "hook-response-session" } as unknown as ClaudeCliPayload,
    { type: "assistant", session_id: "assistant-envelope-session" },
    { type: "result", subtype: "success", session_id: "result-envelope-session", result: "ok" },
  ];
  let canonical: string | undefined;
  const emittedSessions: string[] = [];
  for (const payload of payloads) {
    const decision = classifySessionFromInitPayload(payload, canonical);
    if (decision.kind === "set") {
      canonical = decision.sessionId;
      emittedSessions.push(decision.sessionId);
    }
  }
  assert.equal(canonical, "canonical-session");
  assert.deepEqual(emittedSessions, ["canonical-session"]);

  // 12) 错误结果自身携带新的 session_id 时，恢复事件仍必须指向请求里使用的坏 resume id
  const invalidWithDifferentEnvelopeSession = classifyResultError(
    {
      type: "result",
      subtype: "error_during_execution",
      session_id: "error-envelope-session",
      result: "No conversation found with session ID: stale-resume-session",
    } as ClaudeCliPayload,
    "stale-resume-session",
  );
  assert.deepEqual(invalidWithDifferentEnvelopeSession, {
    kind: "session_invalid",
    sessionId: "stale-resume-session",
    message: "No conversation found with session ID: stale-resume-session",
  });

  // 13) chat 默认保持旧 session；task 续跑 opt-in 后应接纳 Claude resume fork 出的新 session id。
  assert.equal(
    nextCanonicalSessionFromDecision({
      currentSessionId: "old-session",
      decision: { kind: "duplicate-init", ignored: "forked-session" },
    }),
    "old-session",
  );
  assert.equal(
    nextCanonicalSessionFromDecision({
      currentSessionId: "old-session",
      decision: { kind: "duplicate-init", ignored: "forked-session" },
      emitDuplicateSessionIds: true,
    }),
    "forked-session",
  );

  // 14) task 模式不应要求 Agent 向交付物复述工具禁用状态。
  const taskPrompt = buildWorkspaceSystemPrompt({
    workspaceDir: "/tmp/workspace",
    workspacePolicy: "task",
    redactionMode: "passthrough",
    toolSummary: { allowed: ["读取文件"], disabled: ["写入文件"] },
  });
  assert.match(taskPrompt, /严禁在交付结果中描述工具/);
  assert.doesNotMatch(taskPrompt, /请直接说明“当前运行环境已禁用对应工具”/);

  // 14) 会话模式保留直接说明工具禁用状态的用户沟通规则。
  const conversationPrompt = buildWorkspaceSystemPrompt({
    workspaceDir: "/tmp/workspace",
    redactionMode: "strict",
    toolSummary: { allowed: ["读取文件"], disabled: ["写入文件"] },
  });
  assert.match(conversationPrompt, /请直接说明“当前运行环境已禁用对应工具”/);
}

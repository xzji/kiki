import assert from "node:assert/strict";
import fs from "node:fs";

import { enterUserContext } from "@/lib/server/context/userContext";
import { ensureIsolatedPlanningSpecDataDir } from "@/lib/server/runtime/stateSnapshot.spec";
import {
  applySessionMemoryDigest,
  readSessionMemory,
  readSessionMemoryForPrompt,
  writeSessionMemoryManual,
} from "@/lib/server/memory/conversationMemoryService";
import {
  readUserProfileMemory,
  readRelevantUserProfileMemoryForPrompt,
  selectUserMemoryHotZoneForPrompt,
  writeUserProfileMemoryManual,
} from "@/lib/server/memory/userMemoryService";
import {
  cleanupUserMemoryCandidatesForConversation,
  listUserMemoryCandidates,
  recordUserMemoryCandidates,
} from "@/lib/server/memory/userMemoryCandidates";
import { promoteStableUserMemoryCandidates } from "@/lib/server/memory/userMemoryPromotionService";
import { shouldRunMemoryDigest } from "@/lib/server/memory/memoryDigestGate";
import { buildConversationContextPack } from "@/lib/server/workspace/contextPack";

export async function runMemorySpecs() {
  ensureIsolatedPlanningSpecDataDir();
  enterUserContext("memory-spec-user");

  const conversationId = "conv-memory-spec";

  {
    const skipped = shouldRunMemoryDigest({
      conversationId: "conv-gate-hi",
      userMessage: "hi",
      assistantText: "你好",
      aborted: false,
    });
    assert.equal(skipped.shouldRun, false);

    const forced = shouldRunMemoryDigest({
      conversationId: "conv-gate-force",
      userMessage: "hi",
      assistantText: "你好",
      aborted: false,
      force: true,
    });
    assert.equal(forced.shouldRun, true);
    assert.equal(forced.reason, "forced");
  }

  {
    const context = buildConversationContextPack({
      conversation: { title: "测试", status: "idle", messages: [] },
      goal: null,
      recentMessages: [],
      userMemory: "",
      sessionMemory: "",
      quotedMessage: null,
    });
    assert.ok(!context.includes("用户长期记忆"));
    assert.ok(!context.includes("当前会话记忆"));
  }

  {
    await applySessionMemoryDigest({
      conversationId,
      digest: {
        confidence: "medium",
        sessionPatch: {
          goals: ["跟进 goal-secret-1 的方案"],
          openItems: ["继续完成 task-secret-1"],
        },
      },
    });
    const promptMemory = readSessionMemoryForPrompt(conversationId);
    assert.ok(!promptMemory.includes("goal-secret-1"));
    assert.ok(!promptMemory.includes("task-secret-1"));
    assert.ok(promptMemory.includes("<redacted-id>"));
  }

  {
    const first = await writeUserProfileMemoryManual({
      content: "# User Memory\n\n## 沟通偏好\n- 用中文简洁回答\n",
    });
    assert.equal(first.updated, true);
    const conflict = await writeUserProfileMemoryManual({
      content: "# User Memory\n\n## 沟通偏好\n- 覆盖\n",
      expectedHash: "stale",
    });
    assert.equal(conflict.updated, false);
    assert.equal("conflict" in conflict && conflict.conflict, true);
  }

  {
    await recordUserMemoryCandidates({
      conversationId: "conv-candidate-a",
      patches: [
        {
          op: "add",
          section: "workPreferences",
          content: "偏好先执行 tsc 再 build",
          reason: "用户多次要求验证",
          confidence: "high",
        },
      ],
    });
    await recordUserMemoryCandidates({
      conversationId: "conv-candidate-b",
      patches: [
        {
          op: "add",
          section: "workPreferences",
          content: "偏好先执行 tsc 再 build",
          reason: "用户多次要求验证",
          confidence: "high",
        },
      ],
    });
    assert.equal(listUserMemoryCandidates().length >= 1, true);
    const promoted = await promoteStableUserMemoryCandidates();
    assert.equal(promoted.promoted >= 1, true);
    assert.ok(readUserProfileMemory().content.includes("偏好先执行 tsc 再 build"));
  }

  {
    await recordUserMemoryCandidates({
      conversationId: "conv-to-delete",
      patches: [
        {
          op: "add",
          section: "projectPreferences",
          content: "删除清理测试",
          reason: "测试",
          confidence: "high",
        },
      ],
    });
    await cleanupUserMemoryCandidatesForConversation("conv-to-delete");
    assert.equal(
      listUserMemoryCandidates().some((candidate) => candidate.sourceConversationIds.includes("conv-to-delete")),
      false,
    );
  }

  {
    const large = [
      "# User Memory",
      "",
      "## 沟通偏好",
      ...Array.from({ length: 400 }, (_, index) => `- 普通偏好 ${index}`),
      "## 项目偏好",
      "- 重要关键词 alpha beta gamma",
    ].join("\n");
    const hotZone = selectUserMemoryHotZoneForPrompt(large, "alpha", 800);
    assert.ok(hotZone.includes("重要关键词"));
    assert.ok(Buffer.byteLength(hotZone, "utf8") <= 800);
  }

  {
    const current = readSessionMemory(conversationId);
    const result = await writeSessionMemoryManual({
      conversationId,
      content: "",
      expectedHash: current.hash,
    });
    assert.equal(result.updated, true);
    assert.equal(readSessionMemory(conversationId).content, "");
  }

  const memoryRoot = process.env.KIKI_DATA_DIR;
  assert.ok(memoryRoot && fs.existsSync(memoryRoot), "memory spec should use isolated data dir");
  assert.ok(readRelevantUserProfileMemoryForPrompt("tsc").content.includes("tsc"));
}

if (require.main === module) {
  runMemorySpecs();
}

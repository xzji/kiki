import assert from "node:assert/strict";

import { parseClaudeJsonTextWithRepair } from "./claudeJsonInvoke";

function validateObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected object");
  }
  return value as Record<string, unknown>;
}

export async function runClaudeJsonInvokeSpecs() {
  // 本地候选无法修复时，应调用二次 JSON repair 并返回修复后的 parsed。
  {
    let repairCalled = false;
    const result = await parseClaudeJsonTextWithRepair({
      raw: `{"goalDetails":"关注美股","summary":持续跟踪}`,
      validator: validateObject,
      repair: async (malformedJson) => {
        repairCalled = true;
        assert.match(malformedJson, /关注美股/);
        return `{"goalDetails":"关注美股","summary":"持续跟踪"}`;
      },
    });

    assert.equal(repairCalled, true);
    assert.equal(result.meta.strategy, "claude_repair");
    assert.equal(result.meta.repaired, true);
    assert.equal(result.parsed.goalDetails, "关注美股");
  }

  // repair 仍失败时，保守 fallback 应在 repair 之后接管。
  {
    const result = await parseClaudeJsonTextWithRepair({
      raw: `{bad json`,
      validator: validateObject,
      repair: async () => `{still bad`,
      degradedFallback: () => ({ verdict: "needs_refinement" }),
    });

    assert.equal(result.meta.strategy, "degraded_fallback");
    assert.equal(result.parsed.verdict, "needs_refinement");
  }

  // 本地 common_repair 可修复时，不应额外调用 repair。
  {
    let repairCalled = false;
    const result = await parseClaudeJsonTextWithRepair({
      raw: `{"a":1\n"b":2}`,
      validator: validateObject,
      repair: async () => {
        repairCalled = true;
        return "{}";
      },
    });

    assert.equal(repairCalled, false);
    assert.equal(result.parsed.a, 1);
    assert.equal(result.parsed.b, 2);
  }
}

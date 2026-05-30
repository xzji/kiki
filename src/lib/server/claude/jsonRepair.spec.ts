import assert from "node:assert/strict";
import {
  autoCloseTruncatedJson,
  buildJsonParseCandidates,
  parseJsonWithCandidates,
} from "./jsonRepair";

export function runJsonRepairAutoCloseSpecs() {
  // 1. 仅缺最外层 `}`：补 1 个 `}`
  {
    const broken = '{"results":[{"taskId":"1","aligned":true}]';
    const closed = autoCloseTruncatedJson(broken);
    assert.equal(closed, '{"results":[{"taskId":"1","aligned":true}]}');
    JSON.parse(closed); // 必须可解析
  }

  // 2. 缺 `}]`（数组+对象都没闭）：补 `}]`
  {
    const broken = '{"results":[{"taskId":"1","aligned":true';
    const closed = autoCloseTruncatedJson(broken);
    assert.equal(closed, '{"results":[{"taskId":"1","aligned":true}]}');
    JSON.parse(closed);
  }

  // 3. 末尾悬空 `,` 必须先剥离再闭合
  {
    const broken = '{"results":[{"taskId":"1","aligned":true},';
    const closed = autoCloseTruncatedJson(broken);
    assert.equal(closed, '{"results":[{"taskId":"1","aligned":true}]}');
    JSON.parse(closed);
  }

  // 4. 末尾悬空 `"key":` 必须剥离
  {
    const broken = '{"results":[{"taskId":"1","aligned":true}],"goalContribution":';
    const closed = autoCloseTruncatedJson(broken);
    JSON.parse(closed); // 不抛出即可
  }

  // 5. 字符串中截断：必须返回空候选，不要瞎补 `"`
  {
    const broken = '{"results":[{"taskId":"1","reasoning":"未结束的字符串';
    const closed = autoCloseTruncatedJson(broken);
    assert.equal(closed, "", "字符串中截断应返回空候选");
  }

  // 6. 已闭合的合法 JSON：返回空候选（无需 auto close）
  {
    const ok = '{"results":[{"taskId":"1","aligned":true}]}';
    const closed = autoCloseTruncatedJson(ok);
    assert.equal(closed, "", "完整 JSON 不应触发 auto close");
  }

  // 7. 与 parseJsonWithCandidates 集成：截断 JSON 仍能命中 auto_closed
  {
    const broken = '{"results":[{"taskId":"1","aligned":true}]';
    const candidates = buildJsonParseCandidates(broken);
    const labels = candidates.map((c) => c.label);
    assert.ok(labels.includes("auto_closed"));
    assert.ok(labels.includes("auto_closed_common_repair"));
    const attempt = parseJsonWithCandidates(candidates, (v) => v as { results: unknown[] });
    assert.equal(attempt.ok, true);
    if (attempt.ok) {
      assert.ok(["auto_closed", "balanced", "balanced_common_repair", "common_repair"].includes(attempt.strategy));
    }
  }
}

import assert from "node:assert/strict";

import {
  compactFailureReason,
  extractFailureReason,
  formatFailureReasonForPrompt,
} from "@/lib/taskFailureReason";

export function runTaskFailureReasonSpecs() {
  assert.equal(
    extractFailureReason({
      executionErrorMessage: "执行态原因",
      progressError: "progress 原因",
      resultPayload: { errorMessage: "payload 原因" },
    }),
    "执行态原因",
    "execution.errorMessage 优先级最高",
  );

  assert.equal(
    extractFailureReason({
      progressError: "   ",
      resultPayload: { errorMessage: "payload 标准原因" },
    }),
    "payload 标准原因",
    "progress.error 为空时 fallback 到 resultPayload.errorMessage",
  );

  assert.equal(
    extractFailureReason({
      resultPayload: {},
      logs: [
        { level: "error", message: "旧错误", details: "旧详情" },
        { level: "info", message: "普通日志" },
        { level: "error", message: "新错误", details: "新详情" },
      ],
    }),
    "新详情",
    "resultPayload 无原因时 fallback 到最近 error log details",
  );

  assert.equal(extractFailureReason({}), undefined, "没有任何候选原因时返回 undefined");
  assert.equal(
    formatFailureReasonForPrompt(undefined),
    "failureReason=失败原因未记录",
    "prompt 格式化不能伪造未知原因",
  );

  const longReason = "x".repeat(300);
  const compacted = compactFailureReason(longReason);
  assert.equal(compacted?.length, 240, "超长原因应截断到默认长度");
  assert.equal(compacted?.endsWith("…"), true, "截断原因应带省略号");
}

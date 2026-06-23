import assert from "node:assert/strict";

import { shouldShowTaskCardMeta } from "./taskMessagePresentation";

export function runTaskMessagePresentationSpecs() {
  assert.equal(
    shouldShowTaskCardMeta({ inlineResultVisible: true }),
    false,
    "内联任务结果已经自带标题和产出物卡片，不应再显示外层任务标题/状态/摘要",
  );
  assert.equal(
    shouldShowTaskCardMeta({ inlineResultVisible: false }),
    true,
    "无内联结果时仍需要任务卡片元信息作为可点击入口",
  );
}

import assert from "node:assert/strict";
import { refreshReadinessCollections } from "./taskRunnerShared";
import type { TaskReadinessInfoItem } from "@/lib/server/taskReadinessPolicy";

/**
 * taskRunnerShared 共享 helper 的行为契约。重点锁定 Code Review 发现的
 * refreshReadinessCollections 守卫(status 行与 missingUserInfo filter 行
 * 必须同步携带 `source === "user"` 子条件)。
 */

function item(overrides: Partial<TaskReadinessInfoItem>): TaskReadinessInfoItem {
  return {
    id: overrides.id ?? "field-1",
    label: overrides.label ?? "字段",
    description: overrides.description ?? "描述",
    source: overrides.source ?? "user",
    status: overrides.status ?? "available",
    reason: overrides.reason ?? "原因",
  };
}

export function runTaskRunnerSharedSpecs() {
  // 1. status 判定:user 来源的 missing_user → blocked
  {
    const out = refreshReadinessCollections([item({ status: "missing_user", source: "user" })], "2026-06-21", "summary");
    assert.equal(out.status, "blocked");
    assert.equal(out.missingUserInfo.length, 1);
  }

  // 2. agent 来源的 missing_user 不应让 status=blocked,也不应进 missingUserInfo
  //    (两行守卫必须同步——Code Review #2 锁定边界)
  {
    const items = [item({ id: "agent-field", status: "missing_user", source: "agent" })];
    const out = refreshReadinessCollections(items, "2026-06-21", "summary");
    assert.equal(out.status, "ready", "agent 来源的 missing_user 不应让 status=blocked");
    assert.equal(out.missingUserInfo.length, 0, "agent 来源的 missing_user 不应进 missingUserInfo(否则状态自相矛盾)");
  }

  // 3. 混合:user 来源 missing_user + agent 来源 missing_user → 只 user 进 missingUserInfo
  {
    const items = [
      item({ id: "f1", status: "missing_user", source: "user" }),
      item({ id: "f2", status: "missing_user", source: "agent" }),
    ];
    const out = refreshReadinessCollections(items, "2026-06-21", "summary");
    assert.equal(out.status, "blocked");
    assert.equal(out.missingUserInfo.length, 1);
    assert.equal(out.missingUserInfo[0].id, "f1");
  }

  // 4. agent_retrievable / available 分类正确
  {
    const items = [
      item({ id: "f1", status: "agent_retrievable", source: "agent" }),
      item({ id: "f2", status: "available", source: "user" }),
    ];
    const out = refreshReadinessCollections(items, "2026-06-21", "summary");
    assert.equal(out.status, "ready");
    assert.equal(out.agentRetrievableInfo.length, 1);
    assert.equal(out.availableInfo.length, 1);
    assert.equal(out.missingUserInfo.length, 0);
  }

  console.log("taskRunnerShared specs passed");
}

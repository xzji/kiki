import assert from "node:assert/strict";
import { buildTaskReadinessCheck, type TaskReadinessInfoItem } from "./taskReadinessPolicy";
import type { Goal, SubGoal, Task, TaskInstance, TaskRequiredUserInput } from "@/types/kiki";

function buildInput(overrides: {
  requiredUserInputs?: TaskRequiredUserInput[];
  description?: string;
  resumeContext?: string;
}) {
  const task = {
    title: "蜜月偏好与预算澄清",
    description: overrides.description ?? "为用户准备一份蜜月行程方案",
    requiredUserInputs: overrides.requiredUserInputs,
  } as unknown as Task;
  return {
    goal: { title: "蜜月旅行", summary: "" } as unknown as Goal,
    subGoal: { title: "行程规划" } as unknown as SubGoal,
    task,
    instance: { intro: "" } as unknown as TaskInstance,
    resumeContext: overrides.resumeContext,
  };
}

function ids(items: TaskReadinessInfoItem[]) {
  return items.map((item) => item.id).sort();
}

export function runTaskReadinessPolicySpecs() {
  // 优先使用规划期字段清单：枚举全部字段，而非仅预算
  const planned = buildTaskReadinessCheck(
    buildInput({
      requiredUserInputs: [
        { id: "departure_city", label: "出发城市", question: "你从哪出发？" },
        { id: "travel_dates", label: "出行日期", question: "什么时候出行？" },
        { id: "budget", label: "预算", question: "预算多少？" },
        { id: "passport_info", label: "护照信息", question: "护照是否有效？" },
        { id: "preferences", label: "出行偏好", question: "有哪些偏好？" },
      ],
    }),
  );
  assert.equal(planned.status, "blocked");
  assert.deepEqual(ids(planned.missingUserInfo), [
    "budget",
    "departure_city",
    "passport_info",
    "preferences",
    "travel_dates",
  ]);

  // 已知字段命中专用判据 → 标记 available
  const withCity = buildTaskReadinessCheck(
    buildInput({
      requiredUserInputs: [{ id: "departure_city", label: "出发城市", question: "你从哪出发？" }],
      resumeContext: "用户反馈：我从北京出发",
    }),
  );
  assert.equal(withCity.status, "ready");

  // 未知字段：用户反馈含标签 token → available
  const customSatisfied = buildTaskReadinessCheck(
    buildInput({
      requiredUserInputs: [{ id: "passport_info", label: "护照信息", question: "护照是否有效？" }],
      resumeContext: "用户反馈：护照信息齐全，有效期到 2030 年",
    }),
  );
  assert.equal(customSatisfied.status, "ready");

  // 回归：id 含 "date" 子串的非日期字段（如 target_candidates）不得被误判为日期字段而放行
  const candidateField = buildTaskReadinessCheck(
    buildInput({
      requiredUserInputs: [{ id: "target_candidates", label: "候选人名单", question: "请提供候选人名单" }],
      description: "每周日 20:00 触发，整理本周候选人进展",
    }),
  );
  assert.equal(candidateField.status, "blocked");
  assert.deepEqual(ids(candidateField.missingUserInfo), ["target_candidates"]);

  // fallback：无字段清单时退回正则枚举（仅命中预算）
  const fallback = buildTaskReadinessCheck(
    buildInput({ description: "请根据预算筛选合适的方案", requiredUserInputs: undefined }),
  );
  assert.deepEqual(ids(fallback.missingUserInfo), ["budget_constraint"]);
}

/**
 * formatRoleDisplay — DevPanel 角色三 scope 分组（PR15 §12.5.3 / §10.7 问题 27）。
 *
 * 不进 DB 字段，仅 UI 层使用：
 *  - `topic_saga`：interviewer / planner / critic / refiner / presenter
 *  - `thread`：thread_runner
 *  - `task_orchestration`：除上述外的任意 role
 */

export type RoleScope = "topic_saga" | "thread" | "task_orchestration";

export type RoleDisplay = {
  scope: RoleScope;
  label: string;
};

const TOPIC_SAGA_ROLES = new Set([
  "interviewer",
  "planner",
  "critic",
  "refiner",
  "presenter",
]);

export function formatRoleDisplay(role: string): RoleDisplay {
  if (TOPIC_SAGA_ROLES.has(role)) return { scope: "topic_saga", label: role };
  if (role === "thread_runner") return { scope: "thread", label: role };
  return { scope: "task_orchestration", label: role };
}

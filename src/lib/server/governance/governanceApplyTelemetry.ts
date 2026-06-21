/**
 * governanceApplyTelemetry — 会话写桥（同步治理命令）的结构化埋点。
 *
 * 写桥是「会话内容 → 任务调整」的唯一同步写路径，出问题时（误判意图、抢占未生效、
 * 记忆没回写、结果没回流）很难只靠静态代码定位。这里按现有 [governance_tick_*]
 * 标签行的风格补一组打点，方便事后 grep 复盘一条用户指令从判定到落地的全过程。
 *
 * 约定：
 *  - 标签 [governance_apply]，console.info 一行，零文件 IO（测试/沙箱安全）。
 *  - 只记 msgLen 不记用户消息正文，避免把对话内容写进日志（隐私）。
 *  - 用 idempotencyKey 串起同一条指令的多条打点（judge 不在本进程，故以 apply 侧为主）。
 */

export type GovernanceApplyTelemetryEvent =
  | "apply_start"
  | "apply_done"
  | "apply_error"
  | "preempt"
  | "directive_recorded"
  | "replan_downgraded";

type TelemetryFields = Record<string, string | number | boolean | null | undefined>;

function compact(fields: TelemetryFields): TelemetryFields {
  const out: TelemetryFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    out[key] = value;
  }
  return out;
}

export function logGovernanceApply(event: GovernanceApplyTelemetryEvent, fields: TelemetryFields = {}) {
  console.info("[governance_apply]", event, compact(fields));
}

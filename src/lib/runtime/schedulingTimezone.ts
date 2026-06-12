/**
 * 调度/治理时区引导。
 *
 * 必须在任何业务模块 import 之前 import 本文件 —— Node 启动后部分 Date/Intl
 * 行为会缓存进程 TZ，迟到的 process.env.TZ 写入未必生效。本文件只做一件事：
 * 把 KIKI_SCHEDULER_TZ（默认 Asia/Shanghai）写进 process.env.TZ。
 *
 * 落库与 toISOString() 仍统一用 UTC（Z 后缀）；只有"日历语义"（new Date(y,m,d,h,mi)、
 * getHours/getDate）受此 TZ 影响。
 */

const DEFAULT_SCHEDULER_TZ = "Asia/Shanghai";

const requestedTz = process.env.KIKI_SCHEDULER_TZ?.trim();
const resolvedTz = requestedTz && requestedTz.length > 0 ? requestedTz : DEFAULT_SCHEDULER_TZ;

process.env.TZ = resolvedTz;

export const SCHEDULING_TIMEZONE = resolvedTz;

export function describeSchedulingTimezone() {
  let resolved = "<unknown>";
  try {
    resolved = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "<unknown>";
  } catch {
    /* ignore — Intl 在极个别构建里可能不可用 */
  }
  return {
    requested: requestedTz ?? null,
    applied: resolvedTz,
    intlResolved: resolved,
  };
}

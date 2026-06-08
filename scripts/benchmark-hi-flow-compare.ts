/**
 * 对比「hi」对话链路在 本地直连 vs 云端 Railway 两条路径的逐环节耗时。
 *
 * 用法:
 *   LOCAL_BASE_URL=http://localhost:3000 \
 *   CLOUD_BASE_URL=https://kikiagent-production.up.railway.app \
 *   CLOUD_COOKIE='kiki_session=...' \
 *   BENCH_RUNS=3 \
 *   npx tsx scripts/benchmark-hi-flow-compare.ts
 *
 * 说明:
 *   - 本地路径不传 cookie 时会用本地 registry DB 自动签发会话。
 *   - 云端路径必须通过 CLOUD_COOKIE 传入有效会话 cookie（脚本运行机通常无法
 *     访问云端 registry DB）；且需本机 daemon 在线连到该 Railway，否则云端段无法执行。
 *   - 若云端测量缺前置条件，会跳过云端并在输出中显式标注「云端未实测」。
 */
import { runHiFlowOnce, type HiFlowMetrics } from "./benchmark-hi-flow";

const LOCAL_BASE_URL = process.env.LOCAL_BASE_URL ?? "http://localhost:3000";
const CLOUD_BASE_URL =
  process.env.CLOUD_BASE_URL ?? "https://kikiagent-production.up.railway.app";
const CLOUD_COOKIE = process.env.CLOUD_COOKIE;
const RUNS = Math.max(1, Number(process.env.BENCH_RUNS ?? "3") || 3);

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

interface Aggregated {
  governanceMs: number;
  chatHeadersMs: number;
  ttfbMs: number;
  firstDeltaMs: number;
  deltaGapMedian: number;
  deltaCount: number;
  doneMs: number;
  endToEndMs: number;
  shouldHandle: boolean;
  reason: string;
  samples: number;
}

async function runPath(
  label: string,
  baseUrl: string,
  cookie: string | undefined,
): Promise<Aggregated | { error: string }> {
  const results: HiFlowMetrics[] = [];
  for (let i = 0; i < RUNS; i++) {
    try {
      console.log(`\n[${label}] 第 ${i + 1}/${RUNS} 次...`);
      const r = await runHiFlowOnce(baseUrl, { cookie, verbose: false });
      console.log(
        `[${label}] gov=${r.governanceMs}ms ttfb=${r.ttfbMs}ms firstDelta=${r.firstDeltaMs ?? "-"}ms done=${r.doneMs}ms deltas=${r.deltaCount}`,
      );
      results.push(r);
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }
  return {
    governanceMs: median(results.map((r) => r.governanceMs)),
    chatHeadersMs: median(results.map((r) => r.chatHeadersMs)),
    ttfbMs: median(results.map((r) => r.ttfbMs)),
    firstDeltaMs: median(results.map((r) => r.firstDeltaMs ?? 0)),
    deltaGapMedian: median(
      results.map((r) => r.deltaGap?.median ?? 0).filter((v) => v > 0),
    ),
    deltaCount: median(results.map((r) => r.deltaCount)),
    doneMs: median(results.map((r) => r.doneMs)),
    endToEndMs: median(results.map((r) => r.endToEndMs)),
    shouldHandle: results[results.length - 1].governanceShouldHandle,
    reason: results[results.length - 1].governanceReason,
    samples: results.length,
  };
}

function cell(v: number | string): string {
  return String(v).padStart(12);
}

function diffCell(local: number, cloud: number): string {
  const d = cloud - local;
  const sign = d >= 0 ? "+" : "";
  return `${sign}${d}ms`.padStart(12);
}

async function main() {
  console.log(`=== hi 链路本地 vs 云端 对比（每路径 ${RUNS} 次取中位数）===`);
  console.log(`LOCAL_BASE_URL = ${LOCAL_BASE_URL}`);
  console.log(`CLOUD_BASE_URL = ${CLOUD_BASE_URL}`);
  console.log(`CLOUD_COOKIE   = ${CLOUD_COOKIE ? "已提供" : "未提供（将跳过云端）"}`);

  const local = await runPath("本地", LOCAL_BASE_URL, process.env.LOCAL_COOKIE);

  let cloud: Aggregated | { error: string };
  if (!CLOUD_COOKIE) {
    cloud = { error: "未提供 CLOUD_COOKIE，云端未实测" };
  } else {
    cloud = await runPath("云端", CLOUD_BASE_URL, CLOUD_COOKIE);
  }

  console.log(`\n\n================ 对比结果 ================`);

  if ("error" in local) {
    console.log(`本地测量失败: ${local.error}`);
  }
  if ("error" in cloud) {
    console.log(`云端: ${cloud.error}`);
  }

  if (!("error" in local) && !("error" in cloud)) {
    const rows: Array<[string, number, number]> = [
      ["治理判断 (HTTP)", local.governanceMs, cloud.governanceMs],
      ["Chat 首包 HTTP", local.chatHeadersMs, cloud.chatHeadersMs],
      ["SSE 首字节 TTFB", local.ttfbMs, cloud.ttfbMs],
      ["首个 delta", local.firstDeltaMs, cloud.firstDeltaMs],
      ["delta 间隔中位数", local.deltaGapMedian, cloud.deltaGapMedian],
      ["delta 总数", local.deltaCount, cloud.deltaCount],
      ["done 总时长", local.doneMs, cloud.doneMs],
      ["端到端串行", local.endToEndMs, cloud.endToEndMs],
    ];
    console.log(
      `${"环节".padEnd(20)}${"本地直连".padStart(12)}${"云端 Railway".padStart(14)}${"差值".padStart(12)}`,
    );
    console.log("-".repeat(60));
    for (const [name, l, c] of rows) {
      console.log(
        `${name.padEnd(20)}${cell(l)}${cell(c).padStart(14)}${diffCell(l, c)}`,
      );
    }
    console.log("-".repeat(60));
    console.log(
      `治理 shouldHandle: 本地=${local.shouldHandle}(${local.reason}) 云端=${cloud.shouldHandle}(${cloud.reason})`,
    );
  } else if (!("error" in local)) {
    // 仅本地成功，单列输出
    console.log(`\n--- 仅本地结果（中位数）---`);
    console.log(`治理判断 (HTTP):   ${local.governanceMs}ms`);
    console.log(`Chat 首包 HTTP:    ${local.chatHeadersMs}ms`);
    console.log(`SSE 首字节 TTFB:   ${local.ttfbMs}ms`);
    console.log(`首个 delta:        ${local.firstDeltaMs}ms`);
    console.log(`delta 间隔中位数:  ${local.deltaGapMedian}ms`);
    console.log(`delta 总数:        ${local.deltaCount}`);
    console.log(`done 总时长:       ${local.doneMs}ms`);
    console.log(`端到端串行:        ${local.endToEndMs}ms`);
    console.log(
      `治理 shouldHandle: ${local.shouldHandle} (${local.reason})`,
    );
  }
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});

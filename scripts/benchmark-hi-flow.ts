/**
 * 测量普通对话「hi」各环节耗时（模拟 ConversationView 主路径）
 * 用法:
 *   本地直连:  npx tsx scripts/benchmark-hi-flow.ts
 *   指定目标:  BENCH_BASE_URL=https://xxx BENCH_COOKIE='kiki_session=...' npx tsx scripts/benchmark-hi-flow.ts
 *
 * 也可被 benchmark-hi-flow-compare.ts 复用：导出 runHiFlowOnce(baseUrl, opts)。
 */
import { SESSION_COOKIE_NAME } from "@/lib/server/auth/authConfig";
import { runWithUserContext } from "@/lib/server/context/userContext";
import { createSessionForUser } from "@/lib/server/services/authService";
import { getRegistryDatabase } from "@/lib/server/db/registryClient";
import { readRuntimeEnvironmentsSnapshot } from "@/lib/server/runtime/stateSnapshot";
import { DEFAULT_RUNTIME_FILE_POLICY, type ClaudeStreamEvent } from "@/types/runtime";
import type { Conversation } from "@/types/kiki";

const BASE = process.env.BENCH_BASE_URL ?? "http://localhost:3000";

function ms(start: number) {
  return Math.round(performance.now() - start);
}

function fmt(msValue: number) {
  return `${msValue}ms`;
}

/** 单次 hi 链路测量结果（毫秒，全部相对各自起点）。 */
export interface HiFlowMetrics {
  baseUrl: string;
  /** 治理判断 HTTP 往返耗时（请求发出 → 拿到 JSON）。 */
  governanceMs: number;
  governanceShouldHandle: boolean;
  governanceReason: string;
  /** chat 请求发出 → 拿到响应头（首包 HTTP）。 */
  chatHeadersMs: number;
  /** chat 请求发出 → 第一个 SSE 字节（TTFB）。 */
  ttfbMs: number;
  /** chat 请求发出 → 第一个 delta 事件。 */
  firstDeltaMs: number | null;
  /** delta 事件总数。 */
  deltaCount: number;
  /** 相邻 delta 间隔（毫秒）的 min/median/max。无足够样本则为 null。 */
  deltaGap: { min: number; median: number; max: number } | null;
  /** chat 请求发出 → done 事件。 */
  doneMs: number;
  /** 治理判断起点 → done 的端到端串行耗时。 */
  endToEndMs: number;
  /** 逐事件相对时刻明细（相对 chat 起点）。 */
  events: Array<{ type: string; elapsed: number; extra?: string }>;
}

export interface RunHiFlowOptions {
  /** 直接传入会话 cookie（云端必填）；不传则用本地 registry DB 签发。 */
  cookie?: string;
  /** 是否打印逐环节日志（compare 模式下置 false）。 */
  verbose?: boolean;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

/** 执行一次完整 hi 链路并返回逐环节耗时。 */
export async function runHiFlowOnce(
  baseUrl: string,
  opts: RunHiFlowOptions = {},
): Promise<HiFlowMetrics> {
  const verbose = opts.verbose ?? false;
  const origin = baseUrl.replace(/\/$/, "");

  // --- 会话 cookie：优先用传入的，否则本地签发 ---
  let cookie = opts.cookie;
  if (!cookie) {
    const db = getRegistryDatabase();
    const user = db
      .prepare(`SELECT id FROM users WHERE status = 'active' LIMIT 1`)
      .get() as { id: string } | undefined;
    if (!user) {
      throw new Error("本地无活跃用户，请先注册/登录一次，或通过 cookie 传入会话");
    }
    const session = createSessionForUser(user.id);
    cookie = `${SESSION_COOKIE_NAME}=${session.token}`;
    if (verbose) console.log(`[setup] 本地签发会话 user=${user.id}`);
  } else if (verbose) {
    console.log(`[setup] 使用传入 cookie`);
  }

  const headers = {
    "content-type": "application/json",
    cookie,
    origin,
  };

  // --- 0. 扫描本机 Runtime（拿可用 cliPath，组装 runtimeEnv）---
  const discoverRes = await fetch(`${origin}/api/runtime-envs/discover`, {
    headers: { cookie },
  });

  // 尝试用本地快照作为兜底（仅本地有效；云端会失败但不影响 discover 结果）
  let snapshotRuntime: ReturnType<typeof readRuntimeEnvironmentsSnapshot>[number] | undefined;
  try {
    const db = getRegistryDatabase();
    const user = db
      .prepare(`SELECT id FROM users WHERE status = 'active' LIMIT 1`)
      .get() as { id: string } | undefined;
    if (user) {
      const runtimes = runWithUserContext(user.id, () =>
        readRuntimeEnvironmentsSnapshot([]),
      );
      snapshotRuntime =
        runtimes.find((r) => r.type === "local" && r.runtimeKind === "claude") ??
        runtimes[0];
    }
  } catch {
    // 云端无本地 DB，忽略
  }

  let runtimeEnv = snapshotRuntime;
  if (discoverRes.ok) {
    const discovered = (await discoverRes.json()) as {
      items?: Array<{ runtimeKind: string; cliPath?: string; installed: boolean }>;
    };
    const claude = discovered.items?.find(
      (i) => i.runtimeKind === "claude" && i.installed,
    );
    if (claude?.cliPath) {
      runtimeEnv = {
        ...(runtimeEnv ?? {
          id: "bench-runtime",
          type: "local" as const,
          runtimeKind: "claude" as const,
          name: "Claude CLI",
          workingDirectory: process.env.HOME ?? "/tmp",
          permissionMode: "execute" as const,
          filePolicy: DEFAULT_RUNTIME_FILE_POLICY,
        }),
        runtimeKind: "claude",
        cliPath: claude.cliPath,
        health: { status: "online" as const, cliPath: claude.cliPath },
      };
    }
  }

  if (!runtimeEnv?.cliPath) {
    throw new Error(
      "无可用 Claude Runtime（云端通常无法直接 discover，请确保目标可返回已安装的 claude cliPath）",
    );
  }
  if (verbose) console.log(`[setup] 使用 Runtime cli=${runtimeEnv.cliPath}`);

  const conversationId = `conv-bench-${Date.now()}`;
  const now = new Date().toISOString();
  const conversation: Conversation = {
    id: conversationId,
    title: "bench",
    createdAt: now,
    updatedAt: now,
    status: "idle",
    messages: [],
  };

  const userMessage = {
    id: "msg-user-bench",
    kind: "text" as const,
    role: "user" as const,
    content: "hi",
    createdAt: new Date().toISOString(),
    source: "user" as const,
    status: "done" as const,
  };

  const chatBody = {
    message: "hi",
    conversationId,
    runtimeEnv: {
      ...runtimeEnv,
      health: { ...runtimeEnv.health, status: "online" as const },
    },
    source: "conversation" as const,
    workspaceMode: "conversation" as const,
    contextSnapshot: {
      conversation: { ...conversation, messages: [userMessage] },
      goal: null,
    },
  };

  // --- 1. 治理判断 ---
  const tGov = performance.now();
  const govRes = await fetch(`${origin}/api/governance/judge`, {
    method: "POST",
    headers,
    body: JSON.stringify(chatBody),
  });
  const govJson = (await govRes.json()) as {
    shouldHandle?: boolean;
    reason?: string;
  };
  const governanceMs = ms(tGov);
  if (verbose) {
    console.log(
      `\n[1] POST /api/governance/judge  → ${fmt(governanceMs)}  shouldHandle=${govJson.shouldHandle} reason=${govJson.reason ?? "-"}`,
    );
  }

  // --- 2. Claude Chat SSE ---
  const tChatStart = performance.now();
  const chatRes = await fetch(`${origin}/api/claude/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify(chatBody),
  });
  const chatHeadersMs = ms(tChatStart);
  if (verbose) {
    console.log(
      `\n[2] POST /api/claude/chat 首包 HTTP ${chatRes.status}  → ${fmt(chatHeadersMs)}`,
    );
  }

  if (!chatRes.ok || !chatRes.body) {
    const text = await chatRes.text();
    throw new Error(`chat 请求失败 ${chatRes.status}: ${text}`);
  }

  const reader = chatRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let ttfbMs: number | null = null;
  const events: Array<{ type: string; elapsed: number; extra?: string }> = [];
  const deltaTimes: number[] = [];
  let doneMs: number | null = null;

  const record = (type: string, extra?: string) => {
    const elapsed = ms(tChatStart);
    events.push({ type, elapsed, extra });
    if (type === "delta") deltaTimes.push(elapsed);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (ttfbMs === null && value) {
      ttfbMs = ms(tChatStart);
    }
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });

    let idx = buffer.indexOf("\n\n");
    while (idx !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
      if (dataLine) {
        try {
          const event = JSON.parse(dataLine.slice(5).trim()) as ClaudeStreamEvent;
          if (event.type === "delta") {
            record("delta", event.text.slice(0, 20));
          } else if (event.type === "message") {
            record("message", event.content.slice(0, 40));
          } else {
            record(
              event.type,
              "status" in event
                ? String((event as { status?: string }).status)
                : undefined,
            );
          }
          if (event.type === "done") doneMs = ms(tChatStart);
        } catch {
          // ignore
        }
      }
      idx = buffer.indexOf("\n\n");
    }
    if (done) break;
  }

  // 计算 delta 相邻间隔
  let deltaGap: HiFlowMetrics["deltaGap"] = null;
  if (deltaTimes.length >= 2) {
    const gaps: number[] = [];
    for (let i = 1; i < deltaTimes.length; i++) {
      gaps.push(deltaTimes[i] - deltaTimes[i - 1]);
    }
    deltaGap = {
      min: Math.min(...gaps),
      median: median(gaps),
      max: Math.max(...gaps),
    };
  }

  const firstDeltaMs = deltaTimes.length > 0 ? deltaTimes[0] : null;
  const resolvedDone = doneMs ?? ms(tChatStart);
  const endToEndMs = ms(tGov);

  if (verbose) {
    console.log(`[2a] SSE 首字节 (TTFB)              → ${fmt(ttfbMs ?? 0)}`);
    for (const e of events) {
      const label = e.extra ? `${e.type} (${e.extra})` : e.type;
      console.log(`[2b] SSE event ${label.padEnd(28)} → ${fmt(e.elapsed)}`);
    }
    console.log(`[2c] SSE 流结束 (done)              → ${fmt(resolvedDone)}`);
    console.log(`\n=== 汇总 ===`);
    console.log(`治理判断:        ${fmt(governanceMs)}  (shouldHandle=${govJson.shouldHandle})`);
    console.log(`Chat 首包 HTTP:  ${fmt(chatHeadersMs)}`);
    console.log(`SSE 首字节 TTFB: ${fmt(ttfbMs ?? 0)}`);
    console.log(`首个 delta:      ${firstDeltaMs === null ? "-" : fmt(firstDeltaMs)}`);
    console.log(`delta 总数:      ${deltaTimes.length}`);
    console.log(
      `delta 间隔:      ${deltaGap ? `min ${deltaGap.min} / median ${deltaGap.median} / max ${deltaGap.max}` : "样本不足"}`,
    );
    console.log(`done 总时长:     ${fmt(resolvedDone)}（相对 chat 起点）`);
    console.log(`端到端串行:      ${fmt(endToEndMs)}（治理判断起点 → done）`);
  }

  return {
    baseUrl: origin,
    governanceMs,
    governanceShouldHandle: Boolean(govJson.shouldHandle),
    governanceReason: govJson.reason ?? "-",
    chatHeadersMs,
    ttfbMs: ttfbMs ?? 0,
    firstDeltaMs,
    deltaCount: deltaTimes.length,
    deltaGap,
    doneMs: resolvedDone,
    endToEndMs,
    events,
  };
}

async function main() {
  await runHiFlowOnce(BASE, {
    cookie: process.env.BENCH_COOKIE,
    verbose: true,
  });
}

// 仅在直接运行时执行 main（被 import 时不触发）
if (process.argv[1] && process.argv[1].includes("benchmark-hi-flow.ts")) {
  void main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

/**
 * 测量普通对话「hi」各环节耗时（本地 dev，模拟 ConversationView 主路径）
 * 用法: npx tsx scripts/benchmark-hi-flow.ts
 */
import { SESSION_COOKIE_NAME } from "@/lib/server/auth/authConfig";
import { runWithUserContext } from "@/lib/server/context/userContext";
import { createSessionForUser } from "@/lib/server/services/authService";
import { getRegistryDatabase } from "@/lib/server/db/registryClient";
import { readRuntimeEnvironmentsSnapshot } from "@/lib/server/runtime/stateSnapshot";
import type { ClaudeStreamEvent } from "@/types/runtime";
import type { Conversation } from "@/types/kiki";

const BASE = process.env.BENCH_BASE_URL ?? "http://localhost:3000";

function ms(start: number) {
  return Math.round(performance.now() - start);
}

function fmt(msValue: number) {
  return `${msValue}ms`;
}

async function main() {
  const t0 = performance.now();
  const db = getRegistryDatabase();
  const user = db.prepare(`SELECT id FROM users WHERE status = 'active' LIMIT 1`).get() as { id: string } | undefined;
  if (!user) {
    console.error("本地无活跃用户，请先注册/登录一次");
    process.exit(1);
  }
  const session = createSessionForUser(user.id);
  const cookie = `${SESSION_COOKIE_NAME}=${session.token}`;
  console.log(`[setup] 用户 ${user.id}，耗时 ${fmt(ms(t0))}`);

  const runtimes = runWithUserContext(user.id, () => readRuntimeEnvironmentsSnapshot([]));

  const origin = BASE.replace(/\/$/, "");
  const headers = {
    "content-type": "application/json",
    cookie,
    origin,
  };

  // --- 0. 扫描本机 Runtime ---
  const tDiscover = performance.now();
  const discoverRes = await fetch(`${BASE}/api/runtime-envs/discover`, { headers: { cookie } });
  let runtimeEnv = runtimes.find((r) => r.type === "local" && r.runtimeKind === "claude") ?? runtimes[0];
  if (discoverRes.ok) {
    const discovered = (await discoverRes.json()) as { items?: Array<{ runtimeKind: string; cliPath?: string; installed: boolean }> };
    const claude = discovered.items?.find((i) => i.runtimeKind === "claude" && i.installed);
    if (claude?.cliPath) {
      runtimeEnv = {
        ...(runtimeEnv ?? {
          id: "bench-runtime",
          type: "local" as const,
          runtimeKind: "claude" as const,
          name: "Claude CLI",
          workingDirectory: process.env.HOME ?? "/tmp",
          permissionMode: "execute" as const,
          filePolicy: { mode: "project" as const, custom: {} },
        }),
        runtimeKind: "claude",
        cliPath: claude.cliPath,
        health: { status: "online" as const, cliPath: claude.cliPath },
      };
    }
  }
  console.log(`[0] GET /api/runtime-envs/discover      → ${fmt(ms(tDiscover))}`);

  if (!runtimeEnv?.cliPath) {
    console.error("无可用 Claude Runtime");
    process.exit(1);
  }
  console.log(`[setup] 使用 Runtime cli=${runtimeEnv.cliPath}`);

  const conversationId = `conv-bench-${Date.now()}`;
  const conversation: Conversation = {
    id: conversationId,
    title: "bench",
    updatedAt: new Date().toISOString(),
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
    runtimeEnv: { ...runtimeEnv, health: { ...runtimeEnv.health, status: "online" as const } },
    source: "conversation" as const,
    workspaceMode: "conversation" as const,
    contextSnapshot: {
      conversation: { ...conversation, messages: [userMessage] },
      goal: null,
    },
  };

  // --- 1. 治理判断 ---
  const tGov = performance.now();
  const govRes = await fetch(`${BASE}/api/governance/judge`, {
    method: "POST",
    headers,
    body: JSON.stringify(chatBody),
  });
  const govJson = (await govRes.json()) as { shouldHandle?: boolean; reason?: string };
  const govMs = ms(tGov);
  console.log(`\n[1] POST /api/governance/judge  → ${fmt(govMs)}  shouldHandle=${govJson.shouldHandle} reason=${govJson.reason ?? "-"}`);

  // --- 2. Claude Chat SSE ---
  const tChatStart = performance.now();
  const chatRes = await fetch(`${BASE}/api/claude/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify(chatBody),
  });
  const tHeaders = ms(tChatStart);
  console.log(`\n[2] POST /api/claude/chat 首包 HTTP ${chatRes.status}  → ${fmt(tHeaders)}`);

  if (!chatRes.ok || !chatRes.body) {
    console.error(await chatRes.text());
    process.exit(1);
  }

  const reader = chatRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let firstByteMs: number | null = null;
  const eventTimings: Array<{ type: string; elapsed: number; extra?: string }> = [];
  let tDone: number | null = null;

  const record = (type: string, extra?: string) => {
    eventTimings.push({ type, elapsed: ms(tChatStart), extra });
  };

  while (true) {
    const { done, value } = await reader.read();
    if (firstByteMs === null && value) {
      firstByteMs = ms(tChatStart);
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
            record(event.type, "status" in event ? String((event as { status?: string }).status) : undefined);
          }
          if (event.type === "done") tDone = ms(tChatStart);
        } catch {
          // ignore
        }
      }
      idx = buffer.indexOf("\n\n");
    }
    if (done) break;
  }

  console.log(`[2a] SSE 首字节                    → ${fmt(firstByteMs ?? 0)}`);
  for (const e of eventTimings) {
    const label = e.extra ? `${e.type} (${e.extra})` : e.type;
    console.log(`[2b] SSE event ${label.padEnd(28)} → ${fmt(e.elapsed)}`);
  }
  console.log(`[2c] SSE 流结束 (done)              → ${fmt(tDone ?? ms(tChatStart))}`);

  const total = ms(t0);
  console.log(`\n=== 汇总（从脚本开始到 done）===`);
  console.log(`治理判断:     ${fmt(govMs)}`);
  console.log(`Chat 首包:    ${fmt(tHeaders)}`);
  console.log(`Chat 首字节:  ${fmt(firstByteMs ?? 0)}（相对 chat 请求起点）`);
  console.log(`Chat 全程:    ${fmt(tDone ?? 0)}（到 done）`);
  console.log(`端到端总计:   ${fmt(total)}`);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});

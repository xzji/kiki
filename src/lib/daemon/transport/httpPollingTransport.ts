import type { ClaudeStreamEvent } from "@/lib/server/claude/transport";
import type { MachineCommand, MachineResult } from "@/lib/server/tunnel/tunnelHub";
import { fetchWithTimeout, type DaemonOutboundTransport, type DaemonTransportCallbacks } from "@/lib/daemon/transport/types";

const POLL_PATH = "/api/machine-tunnel/poll";
const RESULT_PATH = "/api/machine-tunnel/result";
const STREAM_CHUNK_PATH = "/api/machine-tunnel/stream-chunk";
const RECONNECT_DELAY_MS = 5_000;
const POLL_FETCH_TIMEOUT_MS = 40_000;
const RESULT_FETCH_TIMEOUT_MS = 30_000;
const AUTH_FAILURE_BACKOFF_MS = 60_000;
const AUTH_FAILURE_WARN_THRESHOLD = 3;
const AUTH_FAILURE_REMINDER_EVERY = 30;

async function readPollFailureReason(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { reason?: string };
    return typeof data.reason === "string" && data.reason ? data.reason : `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

export function createHttpPollingOutbound(input: {
  base: string;
  apiKey: string;
  log: (message: string) => void;
}): DaemonOutboundTransport {
  const resultUrl = `${input.base}${RESULT_PATH}`;
  const streamChunkUrl = `${input.base}${STREAM_CHUNK_PATH}`;

  async function sendResult(result: MachineResult) {
    try {
      await fetchWithTimeout(
        resultUrl,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-machine-api-key": input.apiKey },
          body: JSON.stringify(result),
        },
        RESULT_FETCH_TIMEOUT_MS,
      );
    } catch (error) {
      input.log(`回传结果失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function sendStreamChunk(sessionId: string, event: ClaudeStreamEvent, seq: number) {
    const body = JSON.stringify({ sessionId, event, seq });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetchWithTimeout(
          streamChunkUrl,
          {
            method: "POST",
            headers: { "content-type": "application/json", "x-machine-api-key": input.apiKey },
            body,
          },
          RESULT_FETCH_TIMEOUT_MS,
        );
        if (response.ok) return;
        if (attempt === 1) {
          input.log(`流式回传失败：HTTP ${response.status}`);
        }
      } catch (error) {
        if (attempt === 1) {
          input.log(`流式回传失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  return { sendResult, sendStreamChunk };
}

export async function runHttpPollingTransport(input: {
  base: string;
  apiKey: string;
  fingerprint: string;
  daemonVersion: string;
  callbacks: DaemonTransportCallbacks;
  shouldExitAfterHandoff: () => boolean;
  getPendingHandoffCount: () => number;
}): Promise<never> {
  const pollUrl = `${input.base}${POLL_PATH}`;
  input.callbacks.log(`远程 daemon（HTTP 长轮询 v${input.daemonVersion}）连接 ${pollUrl}`);

  let consecutiveAuthFailures = 0;
  let handoffWaitLogged = false;

  for (;;) {
    try {
      const response = await fetchWithTimeout(
        pollUrl,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-machine-api-key": input.apiKey },
          body: JSON.stringify({ fingerprint: input.fingerprint, daemonVersion: input.daemonVersion }),
        },
        POLL_FETCH_TIMEOUT_MS,
      );
      if (response.status === 401) {
        consecutiveAuthFailures += 1;
        const reason = await readPollFailureReason(response);
        const shouldWarn =
          consecutiveAuthFailures === AUTH_FAILURE_WARN_THRESHOLD ||
          (consecutiveAuthFailures > AUTH_FAILURE_WARN_THRESHOLD &&
            (consecutiveAuthFailures - AUTH_FAILURE_WARN_THRESHOLD) % AUTH_FAILURE_REMINDER_EVERY === 0);
        if (shouldWarn) {
          input.callbacks.log(
            `⚠️ 鉴权持续失败（原因：${reason}，本机指纹：${input.fingerprint}）。` +
              `进程仍在运行但服务端判定离线，重试无法自动恢复。` +
              `通常因 api-key 失效或该机器记录已被新连接顶替删除。` +
              `请到网页「运行环境」重新生成连接命令并执行：npm i -g @kiki_agent/daemon@latest && kiki-daemon install --server-url ${input.base} --api-key <新key>`,
          );
        } else if (consecutiveAuthFailures < AUTH_FAILURE_WARN_THRESHOLD) {
          input.callbacks.log(`poll 鉴权失败（${reason}），${AUTH_FAILURE_BACKOFF_MS / 1000}s 后重试…`);
        }
        await input.callbacks.sleep(AUTH_FAILURE_BACKOFF_MS);
        continue;
      }
      if (!response.ok) {
        consecutiveAuthFailures = 0;
        input.callbacks.log(`poll 返回 HTTP ${response.status}，${RECONNECT_DELAY_MS / 1000}s 后重试…`);
        await input.callbacks.sleep(RECONNECT_DELAY_MS);
        continue;
      }
      if (consecutiveAuthFailures > 0) {
        input.callbacks.log("鉴权恢复，连接已重新建立。");
        consecutiveAuthFailures = 0;
      }

      const data = (await response.json()) as {
        ok: boolean;
        userId?: string;
        commands?: MachineCommand[];
      };
      if (data.userId) input.callbacks.onBindUser(data.userId);
      for (const command of data.commands ?? []) {
        await input.callbacks.onCommand(command);
      }

      if (input.shouldExitAfterHandoff()) {
        const pending = input.getPendingHandoffCount();
        if (pending > 0) {
          if (!handoffWaitLogged) {
            input.callbacks.log(`后台服务已接管，待 ${pending} 个在途任务/流式会话完成后前台进程将退出…`);
            handoffWaitLogged = true;
          }
        } else {
          input.callbacks.log("后台服务已接管 24h 运行，前台进程优雅退出（交接完成）。");
          await input.callbacks.sleep(200);
          process.exit(0);
        }
      }
    } catch (error) {
      input.callbacks.log(`poll 失败：${error instanceof Error ? error.message : String(error)}，${RECONNECT_DELAY_MS / 1000}s 后重试…`);
      await input.callbacks.sleep(RECONNECT_DELAY_MS);
    }
  }
}

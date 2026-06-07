import os from "os";
import WebSocket from "ws";

import { appendRuntimeDaemonLog } from "@/lib/daemon/daemonState";
import { enterUserContext, runWithUserContext } from "@/lib/server/context/userContext";
import { runGoalTask } from "@/lib/server/goalTaskRunner";
import { discoverLocalRuntimes, validateRuntimeEnvironment } from "@/lib/server/runtimeEnvValidation";
import { provisionUserWorkspace } from "@/lib/server/services/userProvisioning";
import type { RuntimeJobPayload } from "@/lib/server/repositories/runtimeJobsRepository";
import type { ExecutionTrajectoryStep } from "@/types/executionTrajectory";
import type { TunnelServerMessage } from "@/lib/server/tunnel/tunnelProtocol";
import { MACHINE_TUNNEL_WS_PATH, TUNNEL_PER_MESSAGE_DEFLATE } from "@/lib/server/tunnel/tunnelWsOptions";
import type { RuntimeEnvironmentCheckInput } from "@/types/runtime";

function toWsUrl(serverUrl: string, apiKey: string) {
  const base = serverUrl.replace(/\/$/, "");
  const protocol = base.startsWith("https://")
    ? base.replace("https://", "wss://")
    : base.replace("http://", "ws://");
  return `${protocol}${MACHINE_TUNNEL_WS_PATH}?api-key=${encodeURIComponent(apiKey)}`;
}

function osFingerprint() {
  return `${process.platform}-${process.arch}`;
}

async function executeRemoteJob(input: {
  jobId: string;
  requestId: string;
  payload: RuntimeJobPayload;
  initialTrajectory: ExecutionTrajectoryStep[];
}) {
  const abortController = new AbortController();
  await runGoalTask({
    requestId: input.requestId,
    goal: input.payload.goal,
    subGoal: input.payload.subGoal,
    task: input.payload.task,
    instance: input.payload.instance,
    runtimeEnv: input.payload.runtimeEnv,
    resumeContext: input.payload.resumeContext,
    initialTrajectory: input.initialTrajectory,
    signal: abortController.signal,
  });
}

const DAEMON_VERSION = "0.1.6";
const RECONNECT_DELAY_MS = 5_000;

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** 建立一次连接并处理消息；连接关闭或握手失败时 resolve，由外层循环重连。 */
function runOneConnection(wsUrl: string): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const socket = new WebSocket(wsUrl, { perMessageDeflate: TUNNEL_PER_MESSAGE_DEFLATE });
    let boundUserId: string | null = null;
    let heartbeat: NodeJS.Timeout | null = null;

    socket.on("open", () => {
      socket.send(
        JSON.stringify({
          type: "register",
          machineId: "pending",
          os: osFingerprint(),
          daemonVersion: DAEMON_VERSION,
          fingerprint: osFingerprint(),
        }),
      );
      heartbeat = setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) return;
        socket.send(JSON.stringify({ type: "heartbeat", ts: new Date().toISOString() }));
      }, 15_000);
    });

    socket.on("message", (raw) => {
      let message: TunnelServerMessage | null = null;
      try {
        message = JSON.parse(String(raw)) as TunnelServerMessage;
      } catch {
        return;
      }
      if (message.type === "registered") {
        boundUserId = message.userId;
        provisionUserWorkspace(message.userId);
        enterUserContext(message.userId);
        appendRuntimeDaemonLog(`machine 已注册：${message.machineId}（用户 ${message.userId}）`);
        return;
      }
      if (message.type === "discover_runtimes") {
        void (async () => {
          try {
            const result = await discoverLocalRuntimes();
            socket.send(
              JSON.stringify({
                type: "discover_runtimes_result",
                requestId: message.requestId,
                ok: true,
                items: result.items,
                workingDirectory: os.homedir(),
              }),
            );
          } catch (error) {
            socket.send(
              JSON.stringify({
                type: "discover_runtimes_result",
                requestId: message.requestId,
                ok: false,
                error: error instanceof Error ? error.message : "扫描失败",
              }),
            );
          }
        })();
        return;
      }
      if (message.type === "check_runtime") {
        void (async () => {
          try {
            const result = await validateRuntimeEnvironment(message.payload as RuntimeEnvironmentCheckInput);
            socket.send(
              JSON.stringify({
                type: "check_runtime_result",
                requestId: message.requestId,
                ok: result.ok,
                result,
              }),
            );
          } catch (error) {
            socket.send(
              JSON.stringify({
                type: "check_runtime_result",
                requestId: message.requestId,
                ok: false,
                error: error instanceof Error ? error.message : "检测失败",
              }),
            );
          }
        })();
        return;
      }
      if (message.type !== "execute") return;
      void (async () => {
        try {
          const raw = message.payload as Partial<RuntimeJobPayload> & {
            trajectory?: ExecutionTrajectoryStep[];
          };
          if (!raw.goal || !raw.subGoal || !raw.task || !raw.instance || !raw.runtimeEnv) {
            throw new Error("execute payload 不完整");
          }
          const payload: RuntimeJobPayload = {
            goal: raw.goal,
            subGoal: raw.subGoal,
            task: raw.task,
            instance: raw.instance,
            runtimeEnv: raw.runtimeEnv,
            resumeContext: raw.resumeContext,
          };
          const initialTrajectory = Array.isArray(raw.trajectory) ? raw.trajectory : [];
          if (!boundUserId) {
            throw new Error("machine 尚未完成注册");
          }
          await runWithUserContext(boundUserId, () =>
            executeRemoteJob({
              jobId: message.jobId,
              requestId: message.requestId,
              payload,
              initialTrajectory,
            }),
          );
          socket.send(
            JSON.stringify({
              type: "execute_result",
              jobId: message.jobId,
              ok: true,
            }),
          );
        } catch (error) {
          socket.send(
            JSON.stringify({
              type: "execute_result",
              jobId: message.jobId,
              ok: false,
              error: error instanceof Error ? error.message : "执行失败",
            }),
          );
        }
      })();
    });

    // 握手失败（如部署期间 502）会触发 error 而非 open；必须按重连处理，不能让进程崩溃退出。
    socket.on("unexpected-response", (_req, res) => {
      appendRuntimeDaemonLog(`Tunnel 握手被拒绝（HTTP ${res.statusCode}），${RECONNECT_DELAY_MS / 1000}s 后重连…`);
      try {
        socket.terminate();
      } catch {
        // ignore
      }
      done();
    });

    socket.on("error", (error) => {
      appendRuntimeDaemonLog(
        `Tunnel 连接错误：${error instanceof Error ? error.message : String(error)}，${RECONNECT_DELAY_MS / 1000}s 后重连…`,
      );
      done();
    });

    socket.on("close", () => {
      if (heartbeat) clearInterval(heartbeat);
      appendRuntimeDaemonLog(`Tunnel 连接断开，${RECONNECT_DELAY_MS / 1000}s 后重连…`);
      done();
    });
  });
}

export async function runRemoteDaemonLoop(input: { serverUrl: string; apiKey: string }) {
  const wsUrl = toWsUrl(input.serverUrl, input.apiKey);
  appendRuntimeDaemonLog(`远程 daemon 连接 ${wsUrl}`);

  // 永不退出：任何断开/握手失败都进入重连，避免部署切换期间进程崩溃。
  for (;;) {
    await runOneConnection(wsUrl);
    await sleep(RECONNECT_DELAY_MS);
  }
}

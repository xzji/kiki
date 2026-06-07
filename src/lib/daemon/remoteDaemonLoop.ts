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
import type { RuntimeEnvironmentCheckInput } from "@/types/runtime";

function toWsUrl(serverUrl: string, apiKey: string) {
  const base = serverUrl.replace(/\/$/, "");
  const protocol = base.startsWith("https://")
    ? base.replace("https://", "wss://")
    : base.replace("http://", "ws://");
  return `${protocol}/?api-key=${encodeURIComponent(apiKey)}`;
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

export async function runRemoteDaemonLoop(input: { serverUrl: string; apiKey: string }) {
  const wsUrl = toWsUrl(input.serverUrl, input.apiKey);
  appendRuntimeDaemonLog(`远程 daemon 连接 ${wsUrl}`);

  const connect = () =>
    new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(wsUrl, { perMessageDeflate: false });
      socket.once("open", () => resolve(socket));
      socket.once("error", reject);
    });

  const socket = await connect();
  let boundUserId: string | null = null;
  socket.send(
    JSON.stringify({
      type: "register",
      machineId: "pending",
      os: osFingerprint(),
      daemonVersion: "0.1.3",
      fingerprint: osFingerprint(),
    }),
  );

  const heartbeat = setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "heartbeat", ts: new Date().toISOString() }));
  }, 15_000);

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

  socket.on("close", () => {
    clearInterval(heartbeat);
    appendRuntimeDaemonLog("Tunnel 连接断开，5s 后重连…");
    setTimeout(() => {
      void runRemoteDaemonLoop(input);
    }, 5_000);
  });
}

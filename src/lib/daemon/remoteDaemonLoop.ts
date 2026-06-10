import os from "os";

process.env.KIKI_MACHINE_EXECUTOR = "true";

import { appendRuntimeDaemonLog } from "@/lib/daemon/daemonState";
import { enterUserContext, runWithUserContext } from "@/lib/server/context/userContext";
import { runGoalTask } from "@/lib/server/goalTaskRunner";
import { getKikiDefaultSkillsStatus, installKikiDefaultSkills } from "@/lib/server/kikiSkills/installService";
import { pickDirectoryWithOsascript } from "@/lib/server/runtime/selectWorkingDirectory";
import { discoverLocalRuntimes, validateRuntimeEnvironment } from "@/lib/server/runtimeEnvValidation";
import { provisionUserWorkspace } from "@/lib/server/services/userProvisioning";
import type { RuntimeJobPayload } from "@/lib/server/repositories/runtimeJobsRepository";
import type { ExecutionTrajectoryStep } from "@/types/executionTrajectory";
import type { ClaudeStreamEvent } from "@/lib/server/claude/transport";
import { runRuntimePromptJson, runRuntimePromptText, streamRuntimePrompt } from "@/lib/server/runtime/runtimeTransport";
import { resolveLocalCliCwd } from "@/lib/server/runtime/resolveLocalCliCwd";
import type { MachineCommand, MachineResult, RemotePromptJsonPayload, RemoteStreamPromptPayload } from "@/lib/server/tunnel/tunnelHub";
import type { RuntimeEnvironmentCheckInput } from "@/types/runtime";

const DAEMON_VERSION = "0.2.4";
const POLL_PATH = "/api/machine-tunnel/poll";
const RESULT_PATH = "/api/machine-tunnel/result";
const STREAM_CHUNK_PATH = "/api/machine-tunnel/stream-chunk";
const RECONNECT_DELAY_MS = 5_000;

function normalizeBaseUrl(serverUrl: string) {
  return serverUrl.replace(/\/$/, "");
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
  const base = normalizeBaseUrl(input.serverUrl);
  const pollUrl = `${base}${POLL_PATH}`;
  const resultUrl = `${base}${RESULT_PATH}`;
  const fingerprint = osFingerprint();
  appendRuntimeDaemonLog(`远程 daemon（HTTP 长轮询 v${DAEMON_VERSION}）连接 ${pollUrl}`);

  let boundUserId: string | null = null;
  const runningJobs = new Set<string>();

  async function postResult(result: MachineResult) {
    try {
      await fetch(resultUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-machine-api-key": input.apiKey },
        body: JSON.stringify(result),
      });
    } catch (error) {
      appendRuntimeDaemonLog(`回传结果失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function postStreamChunk(sessionId: string, event: ClaudeStreamEvent, seq: number) {
    const body = JSON.stringify({ sessionId, event, seq });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch(`${base}${STREAM_CHUNK_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-machine-api-key": input.apiKey },
          body,
        });
        if (response.ok) return;
        if (attempt === 1) {
          appendRuntimeDaemonLog(`流式回传失败：HTTP ${response.status}`);
        }
      } catch (error) {
        if (attempt === 1) {
          appendRuntimeDaemonLog(`流式回传失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  async function runPromptOnMachine(payload: RemotePromptJsonPayload, mode: "json" | "text") {
    const cwd = resolveLocalCliCwd({
      cwd: payload.cwd,
      fallbackWorkingDirectory: payload.runtimeEnv.workingDirectory,
      conversationId: payload.conversationId,
    });
    const runner = mode === "json" ? runRuntimePromptJson : runRuntimePromptText;
    return runner({
      prompt: payload.prompt,
      runtimeEnv: payload.runtimeEnv,
      cwd,
      conversationId: payload.conversationId,
      permissionMode: payload.permissionMode,
      toolPolicy: payload.toolPolicy,
      filePolicy: payload.filePolicy,
      channelPolicy: payload.channelPolicy,
      traceContext: payload.traceContext,
    });
  }

  function bindUser(userId: string) {
    if (boundUserId === userId) return;
    boundUserId = userId;
    provisionUserWorkspace(userId);
    enterUserContext(userId);
    appendRuntimeDaemonLog(`machine 已绑定用户 ${userId}`);
  }

  async function handleCommand(command: MachineCommand) {
    if (command.type === "discover_runtimes") {
      try {
        const result = await discoverLocalRuntimes();
        await postResult({
          type: "discover_runtimes",
          requestId: command.requestId,
          ok: true,
          items: result.items,
          workingDirectory: os.homedir(),
        });
      } catch (error) {
        await postResult({
          type: "discover_runtimes",
          requestId: command.requestId,
          ok: false,
          error: error instanceof Error ? error.message : "扫描失败",
        });
      }
      return;
    }
    if (command.type === "check_runtime") {
      try {
        const result = await validateRuntimeEnvironment(command.payload as RuntimeEnvironmentCheckInput);
        await postResult({ type: "check_runtime", requestId: command.requestId, ok: result.ok, result });
      } catch (error) {
        await postResult({
          type: "check_runtime",
          requestId: command.requestId,
          ok: false,
          error: error instanceof Error ? error.message : "检测失败",
        });
      }
      return;
    }
    if (command.type === "select_directory") {
      try {
        const picked = await pickDirectoryWithOsascript();
        if ("canceled" in picked) {
          await postResult({
            type: "select_directory",
            requestId: command.requestId,
            ok: true,
            canceled: true,
          });
          return;
        }
        await postResult({
          type: "select_directory",
          requestId: command.requestId,
          ok: true,
          path: picked.path,
        });
      } catch (error) {
        await postResult({
          type: "select_directory",
          requestId: command.requestId,
          ok: false,
          error: error instanceof Error ? error.message : "目录选择失败",
        });
      }
      return;
    }
    if (command.type === "skills_status") {
      try {
        const result = getKikiDefaultSkillsStatus();
        await postResult({ type: "skills_status", requestId: command.requestId, ok: true, result });
      } catch (error) {
        await postResult({
          type: "skills_status",
          requestId: command.requestId,
          ok: false,
          error: error instanceof Error ? error.message : "KiKi 默认 skills 状态获取失败",
        });
      }
      return;
    }
    if (command.type === "skills_install") {
      try {
        const result = installKikiDefaultSkills();
        await postResult({ type: "skills_install", requestId: command.requestId, ok: true, result });
      } catch (error) {
        await postResult({
          type: "skills_install",
          requestId: command.requestId,
          ok: false,
          error: error instanceof Error ? error.message : "KiKi 默认 skills 安装失败",
        });
      }
      return;
    }
    if (command.type === "run_prompt_json") {
      try {
        const result = await runPromptOnMachine(command.payload, "json");
        await postResult({ type: "run_prompt_json", requestId: command.requestId, ok: true, result });
      } catch (error) {
        await postResult({
          type: "run_prompt_json",
          requestId: command.requestId,
          ok: false,
          error: error instanceof Error ? error.message : "JSON 调用失败",
        });
      }
      return;
    }
    if (command.type === "run_prompt_text") {
      try {
        const result = await runPromptOnMachine(command.payload, "text");
        await postResult({ type: "run_prompt_text", requestId: command.requestId, ok: true, result });
      } catch (error) {
        await postResult({
          type: "run_prompt_text",
          requestId: command.requestId,
          ok: false,
          error: error instanceof Error ? error.message : "文本调用失败",
        });
      }
      return;
    }
    if (command.type === "stream_prompt") {
      void (async () => {
        const payload = command.payload as RemoteStreamPromptPayload;
        let seq = 0;
        const cwd = resolveLocalCliCwd({
          cwd: payload.workingDirectory,
          fallbackWorkingDirectory: payload.workingDirectory,
          conversationId: payload.conversationId,
        });
        try {
          await streamRuntimePrompt({
            message: payload.message,
            workingDirectory: cwd,
            cliPath: payload.cliPath,
            permissionMode: payload.permissionMode,
            runtimeKind: payload.runtimeKind,
            resumeSessionId: payload.resumeSessionId,
            contextPack: payload.contextPack,
            workspacePolicy: payload.workspacePolicy,
            systemPromptMode: payload.systemPromptMode,
            quotedMessage: payload.quotedMessage,
            filePolicy: payload.filePolicy,
            channelPolicy: payload.channelPolicy,
            conversationId: payload.conversationId,
            onEvent: (event) => {
              void postStreamChunk(command.sessionId, event, seq++);
            },
          });
        } catch (error) {
          await postStreamChunk(
            command.sessionId,
            {
              type: "error",
              message: error instanceof Error ? error.message : "流式调用失败",
            },
            seq++,
          );
          await postStreamChunk(command.sessionId, { type: "done" }, seq++);
        }
      })();
      return;
    }
    if (command.type === "execute") {
      // 异步执行，不阻塞 poll 循环（保持心跳与并发）。
      if (runningJobs.has(command.jobId)) return;
      runningJobs.add(command.jobId);
      void (async () => {
        try {
          const raw = command.payload as Partial<RuntimeJobPayload> & { trajectory?: ExecutionTrajectoryStep[] };
          if (!raw.goal || !raw.subGoal || !raw.task || !raw.instance || !raw.runtimeEnv) {
            throw new Error("execute payload 不完整");
          }
          if (!boundUserId) {
            throw new Error("machine 尚未绑定用户");
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
          await runWithUserContext(boundUserId, () =>
            executeRemoteJob({
              jobId: command.jobId,
              requestId: command.requestId,
              payload,
              initialTrajectory,
            }),
          );
          await postResult({ type: "execute", jobId: command.jobId, ok: true });
        } catch (error) {
          await postResult({
            type: "execute",
            jobId: command.jobId,
            ok: false,
            error: error instanceof Error ? error.message : "执行失败",
          });
        } finally {
          runningJobs.delete(command.jobId);
        }
      })();
      return;
    }
    // cancel 等其它命令暂忽略
  }

  // 永不退出：网络/服务端错误都按重试处理。
  for (;;) {
    try {
      const response = await fetch(pollUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-machine-api-key": input.apiKey },
        body: JSON.stringify({ fingerprint, daemonVersion: DAEMON_VERSION }),
      });
      if (!response.ok) {
        appendRuntimeDaemonLog(`poll 返回 HTTP ${response.status}，${RECONNECT_DELAY_MS / 1000}s 后重试…`);
        await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS));
        continue;
      }
      const data = (await response.json()) as {
        ok: boolean;
        userId?: string;
        commands?: MachineCommand[];
      };
      if (data.userId) bindUser(data.userId);
      for (const command of data.commands ?? []) {
        await handleCommand(command);
      }
    } catch (error) {
      appendRuntimeDaemonLog(`poll 失败：${error instanceof Error ? error.message : String(error)}，${RECONNECT_DELAY_MS / 1000}s 后重试…`);
      await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS));
    }
  }
}

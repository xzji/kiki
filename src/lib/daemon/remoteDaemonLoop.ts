import { createHash, randomUUID } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

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
import type {
  MachineCommand,
  MachineResult,
  RemoteDaemonServiceStatus,
  RemotePromptJsonPayload,
  RemoteStreamPromptPayload,
} from "@/lib/server/tunnel/tunnelHub";
import type { RuntimeEnvironmentCheckInput } from "@/types/runtime";

const DAEMON_VERSION = "0.2.7";
const POLL_PATH = "/api/machine-tunnel/poll";
const RESULT_PATH = "/api/machine-tunnel/result";
const STREAM_CHUNK_PATH = "/api/machine-tunnel/stream-chunk";
const RECONNECT_DELAY_MS = 5_000;
// 鉴权（401）退避：重试无法自行恢复，避免每 5s 无意义高频打点
const AUTH_FAILURE_BACKOFF_MS = 60_000;
// 连续 401 达到此次数后打印一次醒目诊断（避免日志刷屏）
const AUTH_FAILURE_WARN_THRESHOLD = 3;
// 持续 401 时，每隔此次数重复一次醒目诊断，避免长期静默让人误以为进程已死
const AUTH_FAILURE_REMINDER_EVERY = 30;
const DEVICE_ID_FILE = "daemon-device-id";

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** 读取 poll 失败响应里的 reason，便于区分 401 的具体原因 */
async function readPollFailureReason(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { reason?: string };
    return typeof data.reason === "string" && data.reason ? data.reason : `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

export type RemoteDaemonServiceManager = {
  installService: () => Promise<RemoteDaemonServiceStatus>;
  uninstallService: () => Promise<RemoteDaemonServiceStatus>;
  serviceStatus: () => Promise<RemoteDaemonServiceStatus>;
};

type RunRemoteDaemonLoopInput = {
  serverUrl: string;
  apiKey: string;
  serviceManager?: RemoteDaemonServiceManager;
};

function normalizeBaseUrl(serverUrl: string) {
  return serverUrl.replace(/\/$/, "");
}

function daemonStateDirectory() {
  if (process.env.KIKI_DAEMON_HOME?.trim()) return process.env.KIKI_DAEMON_HOME.trim();
  if (process.platform === "win32" && process.env.APPDATA) {
    return path.join(process.env.APPDATA, "kiki-agent");
  }
  return path.join(os.homedir(), ".kiki");
}

function fallbackDeviceId() {
  return createHash("sha256")
    .update([os.hostname(), os.homedir(), process.platform, process.arch].join("|"))
    .digest("hex")
    .slice(0, 32);
}

function readOrCreateDeviceId() {
  try {
    const directory = daemonStateDirectory();
    const filePath = path.join(directory, DEVICE_ID_FILE);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.existsSync(filePath)) {
      const existing = fs.readFileSync(filePath, "utf8").trim();
      if (existing) return existing;
    }
    const next = randomUUID();
    fs.writeFileSync(filePath, `${next}\n`, { mode: 0o600 });
    return next;
  } catch {
    return fallbackDeviceId();
  }
}

function osFingerprint() {
  return `device:${process.platform}-${process.arch}:${readOrCreateDeviceId()}`;
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

export async function runRemoteDaemonLoop(input: RunRemoteDaemonLoopInput) {
  const base = normalizeBaseUrl(input.serverUrl);
  const pollUrl = `${base}${POLL_PATH}`;
  const resultUrl = `${base}${RESULT_PATH}`;
  const fingerprint = osFingerprint();
  appendRuntimeDaemonLog(`远程 daemon（HTTP 长轮询 v${DAEMON_VERSION}）连接 ${pollUrl}`);

  let boundUserId: string | null = null;
  const runningJobs = new Set<string>();
  // 进行中的流式会话数（stream_prompt 不进 runningJobs，需单独计数，避免交接退出打断实时流）。
  let activeStreams = 0;
  // 方案 A：前台进程在网页开启 24h、后台服务接管后置位，由主循环择机优雅退出。
  let shouldExitAfterHandoff = false;
  // 避免"等待在途任务"日志每轮 poll 重复打印。
  let handoffWaitLogged = false;

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
    if (command.type === "daemon_service_status") {
      try {
        if (!input.serviceManager) {
          throw new Error("当前 daemon 不支持后台服务状态查询，请更新 @kiki_agent/daemon");
        }
        const result = await input.serviceManager.serviceStatus();
        await postResult({ type: "daemon_service_status", requestId: command.requestId, ok: true, result });
      } catch (error) {
        await postResult({
          type: "daemon_service_status",
          requestId: command.requestId,
          ok: false,
          error: error instanceof Error ? error.message : "后台服务状态获取失败",
        });
      }
      return;
    }
    if (command.type === "daemon_service_autostart") {
      try {
        if (!input.serviceManager) {
          throw new Error("当前 daemon 不支持后台服务设置，请更新 @kiki_agent/daemon");
        }
        if (command.enabled) {
          await input.serviceManager.installService();
        } else {
          await input.serviceManager.uninstallService();
        }
        const result = await input.serviceManager.serviceStatus();
        await postResult({ type: "daemon_service_autostart", requestId: command.requestId, ok: true, result });
        // 方案 A：网页开启 24h 成功后，后台服务（launchd/systemd）已接管 poll。
        // 若当前是非托管的前台进程，则在结果回传后主动退出，避免同机双进程争抢
        // 同一 machineId 的长轮询与命令队列（导致任务丢失/心跳抖动）。
        // 仅在确认后台服务确实 running 时才退出，否则继续 poll 兜底，防止掉线空窗。
        const isManaged = process.env.KIKI_DAEMON_MANAGED === "1";
        if (command.enabled && !isManaged && result.running) {
          shouldExitAfterHandoff = true;
        }
      } catch (error) {
        await postResult({
          type: "daemon_service_autostart",
          requestId: command.requestId,
          ok: false,
          error: error instanceof Error ? error.message : "后台服务设置失败",
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
      activeStreams += 1;
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
        } finally {
          activeStreams -= 1;
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
    appendRuntimeDaemonLog(`忽略未知或暂不支持的命令：${command.type}`);
  }

  // 永不退出：网络/服务端错误都按重试处理。
  let consecutiveAuthFailures = 0;
  for (;;) {
    try {
      const response = await fetch(pollUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-machine-api-key": input.apiKey },
        body: JSON.stringify({ fingerprint, daemonVersion: DAEMON_VERSION }),
      });
      if (response.status === 401) {
        // 鉴权失败：api-key 失效/记录被去重删除/指纹不匹配。重试无法自行恢复，
        // 进程仍在跑但服务端永远判离线 —— 必须给出明确诊断而非静默空转。
        consecutiveAuthFailures += 1;
        const reason = await readPollFailureReason(response);
        const shouldWarn =
          consecutiveAuthFailures === AUTH_FAILURE_WARN_THRESHOLD ||
          (consecutiveAuthFailures > AUTH_FAILURE_WARN_THRESHOLD &&
            (consecutiveAuthFailures - AUTH_FAILURE_WARN_THRESHOLD) % AUTH_FAILURE_REMINDER_EVERY === 0);
        if (shouldWarn) {
          appendRuntimeDaemonLog(
            `⚠️ 鉴权持续失败（原因：${reason}，本机指纹：${fingerprint}）。` +
              `进程仍在运行但服务端判定离线，重试无法自动恢复。` +
              `通常因 api-key 失效或该机器记录已被新连接顶替删除。` +
              `请到网页「运行环境」重新生成连接命令并执行：npm i -g @kiki_agent/daemon@latest && kiki-daemon install --server-url ${base} --api-key <新key>`,
          );
        } else if (consecutiveAuthFailures < AUTH_FAILURE_WARN_THRESHOLD) {
          appendRuntimeDaemonLog(`poll 鉴权失败（${reason}），${AUTH_FAILURE_BACKOFF_MS / 1000}s 后重试…`);
        }
        await sleep(AUTH_FAILURE_BACKOFF_MS);
        continue;
      }
      if (!response.ok) {
        // 瞬时错误（5xx/网络抖动/部署切换）：短间隔重试，可自愈。
        consecutiveAuthFailures = 0;
        appendRuntimeDaemonLog(`poll 返回 HTTP ${response.status}，${RECONNECT_DELAY_MS / 1000}s 后重试…`);
        await sleep(RECONNECT_DELAY_MS);
        continue;
      }
      // 成功：复位鉴权失败计数，恢复正常连接。
      if (consecutiveAuthFailures > 0) {
        appendRuntimeDaemonLog("鉴权恢复，连接已重新建立。");
        consecutiveAuthFailures = 0;
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
      if (shouldExitAfterHandoff) {
        // 等待在途任务（execute）与流式会话（stream_prompt）跑完再退出，
        // 避免中断正在执行的 job 或截断实时流式输出。
        const pending = runningJobs.size + activeStreams;
        if (pending > 0) {
          if (!handoffWaitLogged) {
            appendRuntimeDaemonLog(`后台服务已接管，待 ${pending} 个在途任务/流式会话完成后前台进程将退出…`);
            handoffWaitLogged = true;
          }
        } else {
          appendRuntimeDaemonLog("后台服务已接管 24h 运行，前台进程优雅退出（交接完成）。");
          await sleep(200);
          process.exit(0);
        }
      }
    } catch (error) {
      appendRuntimeDaemonLog(`poll 失败：${error instanceof Error ? error.message : String(error)}，${RECONNECT_DELAY_MS / 1000}s 后重试…`);
      await sleep(RECONNECT_DELAY_MS);
    }
  }
}

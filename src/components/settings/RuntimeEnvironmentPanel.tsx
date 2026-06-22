"use client";

import { Laptop, Loader2, Monitor, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { deleteMachine, listMachines, type MachineRecord } from "@/lib/api/machines";
import {
  fetchRuntimeDaemonStatus,
  setRuntimeDaemonAutoStart,
  type RuntimeDaemonStatusPayload,
} from "@/lib/api/runtime-daemon";
import {
  activateEnvironmentCommand,
  createEnvironmentCommand,
  removeEnvironmentCommand,
  RuntimeEnvironmentCommandError,
  setEnvironmentPermissionModeCommand,
  updateEnvironmentCommand,
} from "@/lib/api/runtime-environment-commands";
import { getRuntimeEnvStatus } from "@/lib/api/runtime-envs";
import {
  fetchKikiSkillsStatus,
  installKikiDefaultSkills,
  type KikiSkillInstallStatus,
  type KikiSkillsInstallPayload,
  type KikiSkillsStatusPayload,
} from "@/lib/api/kiki-skills";
import { normalizeRuntimeFilePolicy } from "@/lib/runtime/toolPolicy";
import { cn } from "@/lib/utils";
import { useRuntimeEnvStore } from "@/stores/runtimeEnvStore";
import type {
  LocalRuntimeKind,
  RuntimeEnvironment,
  RuntimeFilePolicyMode,
  RuntimePermissionMode,
  RuntimeToolCapability,
  RuntimeToolPermissionRule,
} from "@/types/runtime";

import { ConnectMachineDialog } from "./ConnectMachineDialog";
import { LocalRuntimeWizard } from "./LocalRuntimeWizard";
import { RuntimeStatusBadge } from "./RuntimeStatusBadge";

const permissionLabels: Record<RuntimePermissionMode, string> = {
  readonly: "只读聊天",
  confirm: "手动确认",
  execute: "项目内可执行",
};

const runtimeKindLabels: Record<LocalRuntimeKind, string> = {
  claude: "Claude CLI",
  codex: "Codex CLI",
  gemini: "Gemini CLI",
  pi: "Pi CLI",
  cursor: "Cursor CLI",
};

const filePolicyModeLabels: Record<RuntimeFilePolicyMode, string> = {
  all_on: "全部开启",
  all_off: "全部关闭",
  custom: "自定义勾选",
};

const CHECKING_STATUS_STALE_MS = 60_000;

const toolCapabilityOptions: Array<{
  key: RuntimeToolCapability;
  label: string;
  description: string;
  tools: string[];
}> = [
  {
    key: "web",
    label: "联网",
    description: "允许 KiKi 搜索互联网和读取网页内容。",
    tools: ["WebFetch", "WebSearch"],
  },
  {
    key: "fileRead",
    label: "读取文件",
    description: "允许读取当前调用 workspace 内的文件和目录。",
    tools: ["Read", "Glob", "Grep"],
  },
  {
    key: "fileWrite",
    label: "写入文件",
    description: "允许在当前调用 workspace 内创建或修改文件。",
    tools: ["Write", "Edit", "MultiEdit", "NotebookEdit"],
  },
  {
    key: "shell",
    label: "终端命令",
    description: "允许在当前调用 workspace 内执行终端命令。",
    tools: ["Bash", "BashOutput", "KillShell"],
  },
  {
    key: "subagent",
    label: "子代理",
    description: "允许派发子代理或调用已安装 skill 处理复杂任务。",
    tools: ["Task", "TaskOutput", "TaskStop", "Skill", "SlashCommand"],
  },
  {
    key: "schedule",
    label: "定时任务",
    description: "允许创建、删除或查看定时唤醒任务。",
    tools: ["CronCreate", "CronDelete", "CronList", "ScheduleWakeup"],
  },
  {
    key: "planMode",
    label: "Plan Mode",
    description: "允许使用 Claude CLI 内置 plan/worktree 能力。",
    tools: ["EnterPlanMode", "ExitPlanMode", "EnterWorktree", "ExitWorktree"],
  },
];

function formatLocalDateTime(value?: string) {
  if (!value) return "暂无";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function formatMachineFingerprint(fingerprint?: string | null) {
  if (!fingerprint) return "未知平台";
  const matched = /^device:([^:]+):(.+)$/.exec(fingerprint);
  if (!matched) return fingerprint;
  return `${matched[1]} · ${matched[2].slice(0, 8)}`;
}

function isFreshCheckingStatus(environment: RuntimeEnvironment) {
  if (environment.health?.status !== "checking") return false;
  if (!environment.lastCheckedAt) return false;
  const checkedAt = new Date(environment.lastCheckedAt).getTime();
  if (Number.isNaN(checkedAt)) return false;
  return Date.now() - checkedAt < CHECKING_STATUS_STALE_MS;
}

export function RuntimeEnvironmentPanel() {
  const environments = useRuntimeEnvStore((state) => state.environments);
  const setEnvironmentHealth = useRuntimeEnvStore((state) => state.setEnvironmentHealth);
  const setActiveEnvironment = useRuntimeEnvStore((state) => state.setActiveEnvironment);
  const setPermissionMode = useRuntimeEnvStore((state) => state.setPermissionMode);
  const setFilePolicyMode = useRuntimeEnvStore((state) => state.setFilePolicyMode);
  const setFilePolicyCustomCapability = useRuntimeEnvStore((state) => state.setFilePolicyCustomCapability);
  const removeEnvironment = useRuntimeEnvStore((state) => state.removeEnvironment);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [connectDialogOpen, setConnectDialogOpen] = useState(false);
  const [machines, setMachines] = useState<MachineRecord[]>([]);
  const [machinesLoading, setMachinesLoading] = useState(false);
  const [daemonStatus, setDaemonStatus] = useState<RuntimeDaemonStatusPayload | null>(null);
  const [daemonActionMessage, setDaemonActionMessage] = useState<string | null>(null);
  const [daemonActionError, setDaemonActionError] = useState<string | null>(null);
  const [daemonSwitchPending, setDaemonSwitchPending] = useState(false);
  const [daemonRefreshPending, setDaemonRefreshPending] = useState(false);
  const [daemonRefreshFeedback, setDaemonRefreshFeedback] = useState<"error" | null>(null);
  const [confirm24hOpen, setConfirm24hOpen] = useState(false);
  const [optimisticDaemonEnabled, setOptimisticDaemonEnabled] = useState<boolean | null>(null);
  const daemonSwitchPendingRef = useRef(false);
  const daemonStatusInvalidationRef = useRef(0);
  const daemonStatusPollingPendingRef = useRef(false);
  const [skillsStatus, setSkillsStatus] = useState<KikiSkillsStatusPayload | null>(null);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsInstalling, setSkillsInstalling] = useState(false);
  const [skillsMessage, setSkillsMessage] = useState<string | null>(null);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const visibleEnvironments = useMemo(
    () => environments.filter((environment) => environment.type === "local"),
    [environments],
  );
  const localEnvironments = useMemo(
    () => visibleEnvironments.filter((environment) => environment.type === "local"),
    [visibleEnvironments],
  );
  const activeLocalEnvironment = useMemo(
    () =>
      localEnvironments.find((environment) => environment.isDefault) ??
      localEnvironments[0] ??
      null,
    [localEnvironments],
  );
  const connectedMachines = useMemo(
    () => machines.filter((machine) => machine.lastSeenAt !== null),
    [machines],
  );

  const handleRuntimeCommandError = useCallback((error: unknown, fallback: string) => {
    const message = error instanceof Error ? error.message : fallback;
    setDaemonActionError(message);
    console.error(fallback, error);
  }, []);

  const persistEnvironmentPatch = useCallback(async (
    id: string,
    patch: Partial<RuntimeEnvironment>,
  ) => {
    const applyPatch = async () => {
      const result = await updateEnvironmentCommand({ id, patch });
      useRuntimeEnvStore.getState().replaceEnvironments(result.environments, null, result.revision);
    };
    try {
      await applyPatch();
    } catch (error) {
      if (error instanceof RuntimeEnvironmentCommandError && error.conflict) {
        await applyPatch();
        return;
      }
      throw error;
    }
  }, []);

  const refreshEnvironment = useCallback(async (environment: RuntimeEnvironment) => {
    setEnvironmentHealth(environment.id, { status: "checking" });
    try {
      const result = await getRuntimeEnvStatus({
        workingDirectory: environment.workingDirectory,
        cliPath: environment.cliPath,
        runtimeKind: environment.runtimeKind || "claude",
      });
      const checkedAt = new Date().toISOString();
      const health: RuntimeEnvironment["health"] = {
        status: "online",
        cliPath: result.cliPath,
        claudeVersion: result.version,
      };
      setEnvironmentHealth(environment.id, health);
      await persistEnvironmentPatch(environment.id, {
        cliPath: result.cliPath,
        health,
        lastCheckedAt: checkedAt,
      }).catch((error) => handleRuntimeCommandError(error, "Runtime 环境状态保存失败"));
    } catch (error) {
      const checkedAt = new Date().toISOString();
      const health: RuntimeEnvironment["health"] = {
        status: "offline",
        reason: error instanceof Error ? error.message : "环境状态检测失败",
      };
      setEnvironmentHealth(environment.id, health);
      await persistEnvironmentPatch(environment.id, {
        health,
        lastCheckedAt: checkedAt,
      }).catch((persistError) => handleRuntimeCommandError(persistError, "Runtime 环境状态保存失败"));
    }
  }, [handleRuntimeCommandError, persistEnvironmentPatch, setEnvironmentHealth]);

  const handleCreateEnvironment = useCallback(async (environment: Omit<RuntimeEnvironment, "id">) => {
    try {
      const result = await createEnvironmentCommand({ environment });
      if (!result.environment) return;
      useRuntimeEnvStore.getState().replaceEnvironments(result.environments, null, result.revision);
    } catch (error) {
      handleRuntimeCommandError(error, "Runtime 环境创建失败");
    }
  }, [handleRuntimeCommandError]);

  const handleRemoveEnvironment = useCallback(async (environment: RuntimeEnvironment) => {
    const ok = window.confirm(`删除本地环境「${environment.name}」？`);
    if (!ok) return;
    try {
      const removeOnce = () => removeEnvironmentCommand({ id: environment.id });
      let result: Awaited<ReturnType<typeof removeEnvironmentCommand>>;
      try {
        result = await removeOnce();
      } catch (error) {
        if (!(error instanceof RuntimeEnvironmentCommandError) || !error.conflict) {
          throw error;
        }
        result = await removeOnce();
      }
      removeEnvironment(environment.id);
      useRuntimeEnvStore.getState().replaceEnvironments(result.environments, null, result.revision);
    } catch (error) {
      handleRuntimeCommandError(error, "Runtime 环境删除失败");
    }
  }, [handleRuntimeCommandError, removeEnvironment]);

  const handleActivateEnvironment = useCallback(async (environment: RuntimeEnvironment) => {
    try {
      const result = await activateEnvironmentCommand({ id: environment.id });
      setActiveEnvironment(environment.id);
      useRuntimeEnvStore.getState().replaceEnvironments(result.environments, null, result.revision);
    } catch (error) {
      handleRuntimeCommandError(error, "Runtime 环境切换失败");
    }
  }, [handleRuntimeCommandError, setActiveEnvironment]);

  const handlePermissionModeChange = useCallback(async (
    environment: RuntimeEnvironment,
    permissionMode: RuntimePermissionMode,
  ) => {
    try {
      const result = await setEnvironmentPermissionModeCommand({ id: environment.id, permissionMode });
      setPermissionMode(environment.id, permissionMode);
      useRuntimeEnvStore.getState().replaceEnvironments(result.environments, null, result.revision);
    } catch (error) {
      handleRuntimeCommandError(error, "Runtime 权限模式更新失败");
    }
  }, [handleRuntimeCommandError, setPermissionMode]);

  const handleFilePolicyModeChange = useCallback(async (
    environment: RuntimeEnvironment,
    mode: RuntimeFilePolicyMode,
  ) => {
    const filePolicy = {
      ...normalizeRuntimeFilePolicy(environment.filePolicy),
      mode,
    };
    try {
      const result = await updateEnvironmentCommand({
        id: environment.id,
        patch: { filePolicy },
      });
      setFilePolicyMode(environment.id, mode);
      useRuntimeEnvStore.getState().replaceEnvironments(result.environments, null, result.revision);
    } catch (error) {
      handleRuntimeCommandError(error, "Runtime 文件权限更新失败");
    }
  }, [handleRuntimeCommandError, setFilePolicyMode]);

  const handleFilePolicyCapabilityChange = useCallback(async (
    environment: RuntimeEnvironment,
    capability: RuntimeToolCapability,
    enabled: boolean,
  ) => {
    const normalized = normalizeRuntimeFilePolicy(environment.filePolicy);
    const filePolicy = {
      ...normalized,
      custom: {
        ...normalized.custom,
        [capability]: enabled,
      },
    };
    try {
      const result = await updateEnvironmentCommand({
        id: environment.id,
        patch: { filePolicy },
      });
      setFilePolicyCustomCapability(environment.id, capability, enabled);
      useRuntimeEnvStore.getState().replaceEnvironments(result.environments, null, result.revision);
    } catch (error) {
      handleRuntimeCommandError(error, "Runtime 文件权限更新失败");
    }
  }, [handleRuntimeCommandError, setFilePolicyCustomCapability]);

  const handleAllowedToolRulesChange = useCallback(async (
    environment: RuntimeEnvironment,
    allowedToolRules: RuntimeToolPermissionRule[],
  ) => {
    const filePolicy = {
      ...normalizeRuntimeFilePolicy(environment.filePolicy),
      allowedToolRules,
    };
    try {
      const result = await updateEnvironmentCommand({
        id: environment.id,
        patch: { filePolicy },
      });
      useRuntimeEnvStore.getState().setFilePolicy(environment.id, filePolicy);
      useRuntimeEnvStore.getState().replaceEnvironments(result.environments, null, result.revision);
    } catch (error) {
      handleRuntimeCommandError(error, "Runtime 工具规则更新失败");
    }
  }, [handleRuntimeCommandError]);

  useEffect(() => {
    const localEnvironments = environments.filter((item) => item.type === "local");
    localEnvironments.forEach((environment) => {
      if (environment.health?.status === "online" || isFreshCheckingStatus(environment)) return;
      void refreshEnvironment(environment);
    });
  }, [environments, refreshEnvironment]);

  const loadMachines = useCallback(async () => {
    setMachinesLoading(true);
    try {
      const result = await listMachines();
      setMachines(result.machines);
    } catch {
      // 机器列表加载失败不阻断设置页
    } finally {
      setMachinesLoading(false);
    }
  }, []);

  const handleDeleteMachine = useCallback(async (machine: MachineRecord) => {
    const title = machine.name || "本机电脑";
    const message = machine.online
      ? `移除在线电脑「${title}」？\n\n这会立即断开该 daemon；如果之后还要使用，需要重新运行连接命令。`
      : `移除本机电脑「${title}」？`;
    const ok = window.confirm(message);
    if (!ok) return;
    try {
      await deleteMachine(machine.id);
      await loadMachines();
    } catch (error) {
      console.error("删除本机电脑失败", error);
    }
  }, [loadMachines]);

  useEffect(() => {
    daemonSwitchPendingRef.current = daemonSwitchPending;
  }, [daemonSwitchPending]);

  const loadDaemonStatus = useCallback(async () => {
    const invalidationVersion = daemonStatusInvalidationRef.current;
    const next = await fetchRuntimeDaemonStatus();
    if (invalidationVersion === daemonStatusInvalidationRef.current && !daemonSwitchPendingRef.current) {
      setDaemonStatus(next);
    }
    return next;
  }, []);

  const loadKikiSkillsStatus = useCallback(async () => {
    setSkillsLoading(true);
    setSkillsError(null);
    try {
      const next = await fetchKikiSkillsStatus();
      setSkillsStatus(next);
      return next;
    } catch (error) {
      setSkillsError(error instanceof Error ? error.message : "KiKi 默认 skills 状态获取失败");
      return null;
    } finally {
      setSkillsLoading(false);
    }
  }, []);

  const handleInstallKikiSkills = useCallback(async () => {
    if (skillsInstalling) return;
    setSkillsInstalling(true);
    setSkillsMessage(null);
    setSkillsError(null);
    try {
      const result = await installKikiDefaultSkills();
      setSkillsStatus(result);
      setSkillsMessage(formatKikiSkillsInstallMessage(result));
    } catch (error) {
      setSkillsError(error instanceof Error ? error.message : "KiKi 默认 skills 安装失败");
    } finally {
      setSkillsInstalling(false);
    }
  }, [skillsInstalling]);

  const daemonService = daemonStatus?.service;
  const daemonEnabled = daemonService
    ? Boolean(daemonService.installed && daemonService.running)
    : Boolean(daemonStatus?.config?.autoStart && daemonStatus?.launchAgentInstalled);
  const effectiveDaemonEnabled = optimisticDaemonEnabled ?? daemonEnabled;
  const isRemoteDaemonSource = daemonStatus?.source === "remote";
  const daemonDescription = isRemoteDaemonSource
    ? "通过已连接本机 daemon 注册系统后台服务，关闭浏览器或云端页面后仍可继续连接云端并执行任务。开启成功后请关闭当前前台 kiki-daemon run 终端，避免双进程抢占。"
    : "为当前本地 Runtime 安装系统常驻守护，关闭浏览器后依然可以继续调度任务。默认关闭，首次开启时会提示你确认安装 LaunchAgent；关闭后会自动停用系统常驻。";

  const refreshDaemonStatus = useCallback(async () => {
    if (daemonRefreshPending) return;
    setDaemonRefreshPending(true);
    setDaemonRefreshFeedback(null);
    try {
      await loadDaemonStatus();
    } catch {
      setDaemonRefreshFeedback("error");
    } finally {
      setDaemonRefreshPending(false);
    }
  }, [daemonRefreshPending, loadDaemonStatus]);

  const applyDaemonToggle = useCallback(async (enabled: boolean) => {
    if (enabled && !activeLocalEnvironment) {
      setDaemonActionError("请先连接一个本地 Runtime 环境，再开启 24h 运行");
      return;
    }

    setDaemonSwitchPending(true);
    setOptimisticDaemonEnabled(enabled);
    setDaemonActionMessage(null);
    setDaemonActionError(null);
    setDaemonRefreshFeedback(null);
    daemonSwitchPendingRef.current = true;
    daemonStatusInvalidationRef.current += 1;
    try {
      const result = await setRuntimeDaemonAutoStart(
        enabled
          ? {
              enabled: true,
              environment: {
                name: activeLocalEnvironment?.name || "KiKi Local Runtime",
                workingDirectory: activeLocalEnvironment?.workingDirectory || "",
                cliPath: activeLocalEnvironment?.cliPath || "claude",
                permissionMode: activeLocalEnvironment?.permissionMode || "execute",
                filePolicy: activeLocalEnvironment?.filePolicy,
              },
            }
          : { enabled: false },
      );
      daemonStatusInvalidationRef.current += 1;
      setDaemonStatus((current) => ({
        config: result.config,
        state: current?.state ?? null,
        device: current?.device ?? null,
        source: result.source ?? current?.source,
        service: result.service ?? current?.service,
        message: result.message,
        launchAgentInstalled: result.launchAgentInstalled,
        launchAgentPath: result.launchAgentPath,
      }));
      setDaemonActionMessage(
        enabled
          ? "24h 运行已开启，后台服务已接管；如果当前还有前台 kiki-daemon run 终端，请关闭它以避免双进程抢占。"
          : "24h 运行已关闭，系统常驻后台服务已停用。",
      );
    } catch (error) {
      daemonStatusInvalidationRef.current += 1;
      setOptimisticDaemonEnabled(null);
      setDaemonStatus((current) => (current?.message ? { ...current, message: undefined } : current));
      setDaemonActionError(error instanceof Error ? error.message : "24h 运行设置失败");
    } finally {
      daemonSwitchPendingRef.current = false;
      setOptimisticDaemonEnabled(null);
      setDaemonSwitchPending(false);
    }
  }, [activeLocalEnvironment]);

  const daemonStatusBadge = useMemo(() => {
    if (daemonSwitchPending) return { label: "加载中", tone: "neutral" as const, loading: true };
    if (daemonRefreshPending) return { label: "刷新中", tone: "neutral" as const, loading: true };
    if (daemonRefreshFeedback === "error") return { label: "刷新失败", tone: "error" as const, loading: false };
    if (!effectiveDaemonEnabled) return { label: "已关闭", tone: "neutral" as const, loading: false };
    if (daemonStatus?.state?.status === "error") return { label: "异常", tone: "error" as const, loading: false };
    return { label: "运行中", tone: "neutral" as const, loading: false };
  }, [daemonRefreshFeedback, daemonRefreshPending, daemonStatus?.state?.status, daemonSwitchPending, effectiveDaemonEnabled]);

  useEffect(() => {
    if (!daemonRefreshFeedback) return;
    const timer = window.setTimeout(() => setDaemonRefreshFeedback(null), 2000);
    return () => window.clearTimeout(timer);
  }, [daemonRefreshFeedback]);

  useEffect(() => {
    void loadMachines();
    const timer = window.setInterval(() => {
      void loadMachines();
    }, 10000);
    return () => window.clearInterval(timer);
  }, [loadMachines]);

  useEffect(() => {
    let cancelled = false;
    const safeLoadDaemonStatus = async () => {
      if (daemonSwitchPendingRef.current) return;
      if (daemonStatusPollingPendingRef.current) return;
      daemonStatusPollingPendingRef.current = true;
      const invalidationVersion = daemonStatusInvalidationRef.current;
      try {
        const next = await fetchRuntimeDaemonStatus();
        if (!cancelled && invalidationVersion === daemonStatusInvalidationRef.current && !daemonSwitchPendingRef.current) {
          setDaemonStatus(next);
        }
      } catch {
        if (!cancelled && invalidationVersion === daemonStatusInvalidationRef.current && !daemonSwitchPendingRef.current) {
          setDaemonStatus(null);
        }
      } finally {
        daemonStatusPollingPendingRef.current = false;
      }
    };
    void safeLoadDaemonStatus();
    const timer = window.setInterval(() => {
      void safeLoadDaemonStatus();
    }, 10000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    void loadKikiSkillsStatus();
  }, [loadKikiSkillsStatus]);

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-[#E5E7EB] bg-white px-5 py-4">
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <div className="text-[15px] font-medium text-[#111]">连接 Runtime</div>
            <div className="mt-1 text-[13px] text-[#6B7280]">
              连接本机电脑作为执行节点，或添加本地 CLI 环境供会话使用。
            </div>
          </div>
            <div className="flex flex-none flex-wrap items-center gap-2 md:justify-end">
            <button
              type="button"
              onClick={() => setConnectDialogOpen(true)}
              className="inline-flex h-9 min-w-[128px] shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-[#111] bg-[#111] px-3 text-[13px] text-white hover:bg-[#222]"
            >
              <Monitor className="h-4 w-4" />
              连接本机电脑
            </button>
            <button
              type="button"
              onClick={() => setWizardOpen(true)}
              className="inline-flex h-9 min-w-[128px] shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-[#E5E7EB] bg-white px-3 text-[13px] text-[#111] hover:bg-[#F8F9FB]"
            >
              <Plus className="h-4 w-4" />
              添加本地环境
            </button>
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[15px] font-medium text-[#111]">已连接电脑</div>
            <div className="mt-1 text-[13px] text-[#6B7280]">
              云端任务会下发到在线的本机电脑，由你本机的 CLI 执行。
            </div>
          </div>
          <button
            type="button"
            onClick={() => void loadMachines()}
            disabled={machinesLoading}
            className="inline-flex h-8 items-center gap-1 rounded-lg border border-[#E5E7EB] bg-white px-2.5 text-[12px] text-[#475467] hover:bg-[#F8F9FB] disabled:opacity-70"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", machinesLoading && "animate-spin")} />
            刷新
          </button>
        </div>
        <div className="grid gap-3">
          {connectedMachines.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-[#E5E7EB] bg-[#FAFAFB] px-5 py-6 text-center">
              <div className="text-[13px] text-[#6B7280]">还没有连接的本机电脑</div>
              <button
                type="button"
                onClick={() => setConnectDialogOpen(true)}
                className="mt-3 inline-flex h-9 items-center gap-2 rounded-lg border border-[#111] bg-[#111] px-3 text-[13px] text-white hover:bg-[#222]"
              >
                <Monitor className="h-4 w-4" />
                连接本机电脑
              </button>
            </div>
          ) : (
            connectedMachines.map((machine) => (
              <div
                key={machine.id}
                className={cn(
                  "rounded-2xl border bg-white px-5 py-4",
                  machine.online ? "border-[#111]" : "border-[#E5E7EB]",
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#E5E7EB] bg-[#F8F9FB] text-[#1F2328]">
                      <Monitor className="h-4 w-4" />
                    </span>
                    <div className="min-w-0">
                      <div className="truncate text-[14px] font-medium text-[#111]">
                        {machine.name || "本机电脑"}
                      </div>
                      <div className="mt-0.5 text-[12px] text-[#6B7280]">
                        {formatMachineFingerprint(machine.fingerprint)} · {formatLocalDateTime(machine.lastSeenAt ?? undefined)}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "rounded-full border px-2 py-1 text-[11px]",
                        machine.online
                          ? "border-[#D1FADF] bg-[#ECFDF3] text-[#067647]"
                          : "border-[#E5E7EB] bg-[#FAFAFB] text-[#6B7280]",
                      )}
                    >
                      {machine.online ? "在线" : "离线"}
                    </span>
                    <button
                      type="button"
                      aria-label="移除本机电脑"
                      title={machine.online ? "移除并断开此在线电脑" : "移除本机电脑"}
                      onClick={() => void handleDeleteMachine(machine)}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[#E5E7EB] bg-white text-[#B42318] hover:bg-[#FEF2F2]"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      {connectDialogOpen ? (
        <ConnectMachineDialog
          open={connectDialogOpen}
          onClose={() => setConnectDialogOpen(false)}
          onConnected={() => {
            void loadMachines();
          }}
        />
      ) : null}

      {wizardOpen ? (
        <LocalRuntimeWizard
          open={wizardOpen}
          onClose={() => setWizardOpen(false)}
          onSave={(environment) => {
            void handleCreateEnvironment(environment);
          }}
        />
      ) : null}

      <section className="space-y-4">
        <div>
          <div className="text-[15px] font-medium text-[#111]">已连接环境</div>
          <div className="mt-1 text-[13px] text-[#6B7280]">
            当前环境用于会话执行；如果需要关闭浏览器后继续运行，再为当前本地环境开启 `24h 运行`。
          </div>
        </div>
        <div className="grid gap-3">
          {visibleEnvironments.map((environment) => (
          <div
            key={environment.id}
            className={cn(
              "rounded-2xl border bg-white px-5 py-4",
              environment.isDefault ? "border-[#111]" : "border-[#E5E7EB]",
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-3">
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#E5E7EB] bg-[#F8F9FB] text-[#1F2328]">
                    <Laptop className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <div className="truncate text-[14px] font-medium text-[#111]">
                      {environment.name}
                    </div>
                    <div className="mt-0.5 text-[12px] text-[#6B7280]">
                      {runtimeKindLabels[environment.runtimeKind || "claude"]}
                    </div>
                  </div>
                  {environment.isDefault ? (
                    <span className="rounded-full border border-[#111] px-2 py-1 text-[11px] text-[#111]">
                      当前环境
                    </span>
                  ) : null}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <RuntimeStatusBadge health={environment.health} />
                {environment.type === "local" ? (
                  <button
                    type="button"
                    onClick={() => void refreshEnvironment(environment)}
                    className="inline-flex h-8 items-center gap-1 rounded-lg border border-[#E5E7EB] bg-white px-2.5 text-[12px] text-[#475467] hover:bg-[#F8F9FB]"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    重新检测
                  </button>
                ) : null}
                {environment.type === "local" ? (
                  <button
                    type="button"
                    aria-label="删除本地环境"
                    onClick={() => {
                      void handleRemoveEnvironment(environment);
                    }}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[#E5E7EB] bg-white text-[#B42318] hover:bg-[#FEF2F2]"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                ) : null}
                {!environment.isDefault ? (
                  <button
                    type="button"
                    onClick={() => void handleActivateEnvironment(environment)}
                    className="inline-flex h-8 items-center rounded-lg border border-[#E5E7EB] bg-white px-2.5 text-[12px] text-[#1F2328] hover:bg-[#F8F9FB]"
                  >
                    设为当前环境
                  </button>
                ) : null}
              </div>
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <InfoField
                label="工作目录"
                value={environment.workingDirectory}
              />
              <InfoField label="CLI 路径" value={environment.cliPath} />
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-3 rounded-2xl border border-[#E5E7EB] bg-[#FAFAFB] px-4 py-3">
              <div>
                <div className="text-[12px] text-[#6B7280]">执行权限模式</div>
                <div className="mt-1 text-[13px] text-[#111]">
                  {permissionLabels[environment.permissionMode]}
                </div>
              </div>
              {environment.type === "local" ? (
                <div className="ml-auto flex items-center gap-2">
                  {(["readonly", "confirm", "execute"] as RuntimePermissionMode[]).map((mode) => {
                    const disabled = environment.runtimeKind === "codex" && mode === "confirm";
                    return (
                      <button
                        key={mode}
                        type="button"
                        disabled={disabled}
                        title={disabled ? "Codex exec 首版不支持 KiKi 弹窗确认" : undefined}
                        onClick={() => {
                          if (!disabled) void handlePermissionModeChange(environment, mode);
                        }}
                        className={cn(
                          "rounded-full border px-3 py-1.5 text-[12px] transition",
                          disabled && "cursor-not-allowed opacity-45",
                          mode === environment.permissionMode
                            ? "border-[#111] bg-white text-[#111]"
                            : "border-[#E5E7EB] bg-white text-[#6B7280] hover:text-[#111]",
                        )}
                      >
                        {permissionLabels[mode]}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>

            {environment.runtimeKind === "codex" && environment.permissionMode === "confirm" ? (
              <div className="mt-3 rounded-2xl border border-[#FDE68A] bg-[#FFFBEB] px-4 py-3 text-[12px] leading-5 text-[#92400E]">
                Codex exec 首版不支持 KiKi 手动确认。请切换为“只读聊天”或“项目内可执行”；后端会把历史 confirm 配置按只读处理。
              </div>
            ) : null}

            {environment.type === "local" ? (
              <ToolPolicySection
                environment={environment}
                onModeChange={(mode) => void handleFilePolicyModeChange(environment, mode)}
                onCapabilityChange={(capability, enabled) =>
                  void handleFilePolicyCapabilityChange(environment, capability, enabled)
                }
                onAllowedToolRulesChange={(rules) => void handleAllowedToolRulesChange(environment, rules)}
              />
            ) : null}

            {environment.type === "local" ? (
              environment.isDefault ? (
                <div className="mt-3 rounded-2xl border border-[#E5E7EB] bg-[#FAFAFB] px-4 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="text-[13px] font-medium text-[#111]">24h 运行</div>
                        <span
                          className={cn(
                            "rounded-full border px-2 py-1 text-[11px]",
                            daemonStatusBadge.tone === "error"
                              ? "border-[#FECACA] bg-[#FEF2F2] text-[#B42318]"
                              : "border-[#E5E7EB] bg-white text-[#111]",
                          )}
                        >
                          {daemonStatusBadge.loading ? (
                            <span className="inline-flex items-center gap-1">
                              <Loader2 className="h-3 w-3 animate-spin" />
                              {daemonStatusBadge.label}
                            </span>
                          ) : daemonStatusBadge.label}
                        </span>
                        <button
                          type="button"
                          onClick={() => void refreshDaemonStatus()}
                          disabled={daemonSwitchPending || daemonRefreshPending}
                          className={cn(
                            "inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-70",
                            daemonRefreshPending
                              ? "border-[#111] bg-[#111] text-white"
                              : "border-[#E5E7EB] bg-white text-[#475467] hover:border-[#D0D5DD] hover:bg-[#F8F9FB]",
                          )}
                        >
                          <RefreshCw className={cn("h-3.5 w-3.5", daemonRefreshPending && "animate-spin")} />
                          刷新状态
                        </button>
                      </div>
                      <div className="mt-1 text-[12px] leading-5 text-[#6B7280]">{daemonDescription}</div>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={effectiveDaemonEnabled}
                      disabled={daemonSwitchPending}
                      onClick={() => {
                        if (daemonSwitchPending) return;
                        if (!effectiveDaemonEnabled) {
                          setConfirm24hOpen(true);
                          return;
                        }
                        void applyDaemonToggle(false);
                      }}
                      className={cn(
                        "relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors",
                        effectiveDaemonEnabled ? "bg-[#111]" : "bg-[#D0D5DD]",
                        daemonSwitchPending && "cursor-not-allowed opacity-70",
                      )}
                    >
                      <span
                        className={cn(
                          "inline-block h-5 w-5 rounded-full bg-white transition-transform",
                          effectiveDaemonEnabled ? "translate-x-6" : "translate-x-1",
                        )}
                      />
                    </button>
                  </div>

                  {effectiveDaemonEnabled ? (
                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                      <InfoField
                        label="最近心跳"
                        value={formatLocalDateTime(daemonStatus?.state?.lastHeartbeatAt)}
                        loading={daemonSwitchPending}
                      />
                      <InfoField
                        label="上次完成"
                        value={formatLocalDateTime(daemonStatus?.state?.lastJobFinishedAt)}
                        loading={daemonSwitchPending}
                      />
                      <InfoField
                        label="设备 ID"
                        value={daemonStatus?.device?.deviceId || "未生成"}
                        loading={daemonSwitchPending}
                      />
                      <InfoField
                        label="后台服务"
                        value={
                          daemonService
                            ? `${daemonService.installed ? "已安装" : "未安装"} / ${daemonService.running ? "运行中" : "未运行"}`
                            : daemonStatus?.launchAgentInstalled
                              ? "已安装"
                              : "未安装"
                        }
                        loading={daemonSwitchPending}
                      />
                      <InfoField
                        label="服务配置路径"
                        value={daemonService?.path || daemonStatus?.launchAgentPath || "暂无"}
                        loading={daemonSwitchPending}
                      />
                    </div>
                  ) : null}

                  {daemonActionMessage ? (
                    <div className="mt-3 rounded-2xl border border-[#BBF7D0] bg-[#F0FDF4] px-4 py-3 text-[12px] leading-5 text-[#166534]">
                      {daemonActionMessage}
                    </div>
                  ) : null}
                  {daemonStatus?.message ? (
                    <div className="mt-3 rounded-2xl border border-[#FEDF89] bg-[#FFFBEB] px-4 py-3 text-[12px] leading-5 text-[#B54708]">
                      {daemonStatus.message}
                    </div>
                  ) : null}
                  {daemonActionError ? (
                    <div className="mt-3 rounded-2xl border border-[#FECACA] bg-[#FEF2F2] px-4 py-3 text-[12px] leading-5 text-[#B42318]">
                      {daemonActionError}
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="mt-3 rounded-2xl border border-[#E5E7EB] bg-[#FAFAFB] px-4 py-3 text-[12px] leading-5 text-[#6B7280]">
                  将这个本地环境设为当前环境后，才可以为它配置 `24h 运行`。
                </div>
              )
            ) : null}

            {environment.health && "reason" in environment.health ? (
              <div className="mt-3 text-[12px] leading-5 text-[#B42318]">
                {environment.health.reason}
              </div>
            ) : null}
          </div>
          ))}
        </div>
      </section>

      <KikiDefaultSkillsSection
        status={skillsStatus}
        loading={skillsLoading}
        installing={skillsInstalling}
        message={skillsMessage}
        error={skillsError}
        onRefresh={() => void loadKikiSkillsStatus()}
        onInstall={() => void handleInstallKikiSkills()}
        onConnectMachine={() => setConnectDialogOpen(true)}
      />

      <EnableDaemonConfirmDialog
        open={confirm24hOpen}
        environmentName={activeLocalEnvironment?.name || "当前本地 Runtime"}
        remote={isRemoteDaemonSource}
        pending={daemonSwitchPending}
        onClose={() => {
          if (daemonSwitchPending) return;
          setConfirm24hOpen(false);
        }}
        onConfirm={() => {
          setConfirm24hOpen(false);
          void applyDaemonToggle(true);
        }}
      />
    </div>
  );
}

function capabilityConstraint(
  capability: RuntimeToolCapability,
  permissionMode: RuntimePermissionMode,
) {
  if (capability === "shell" && permissionMode !== "execute") return "需要执行权限模式 = 项目内可执行";
  if (capability === "fileWrite" && permissionMode === "readonly") return "只读聊天下不会生效";
  return "";
}

function formatKikiSkillsInstallMessage(result: KikiSkillsInstallPayload) {
  return result.message || `已安装 ${result.installedNow} 个，更新 ${result.updatedNow} 个，跳过 ${result.skipped} 个。`;
}

const kikiSkillStatusLabels: Record<KikiSkillInstallStatus, { label: string; className: string }> = {
  installed: {
    label: "已安装",
    className: "border-[#D1FADF] bg-[#ECFDF3] text-[#067647]",
  },
  outdated: {
    label: "需更新",
    className: "border-[#FEDF89] bg-[#FFFAEB] text-[#B54708]",
  },
  not_installed: {
    label: "未安装",
    className: "border-[#E5E7EB] bg-white text-[#6B7280]",
  },
  blocked: {
    label: "冲突",
    className: "border-[#FECACA] bg-[#FEF2F2] text-[#B42318]",
  },
};

function KikiDefaultSkillsSection({
  status,
  loading,
  installing,
  message,
  error,
  onRefresh,
  onInstall,
  onConnectMachine,
}: {
  status: KikiSkillsStatusPayload | null;
  loading: boolean;
  installing: boolean;
  message: string | null;
  error: string | null;
  onRefresh: () => void;
  onInstall: () => void;
  onConnectMachine: () => void;
}) {
  const installLabel =
    status && status.notInstalled === 0 && status.outdated === 0
      ? "重新同步"
      : "安装 KiKi 默认 skills";
  const canInstall = !loading && !installing;
  const targetRoot = status?.targetRoot || "~/.claude/skills";

  return (
    <section className="rounded-2xl border border-[#E5E7EB] bg-white px-5 py-4">
      <div className="grid items-start gap-4 md:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0">
          <div className="text-[15px] font-medium text-[#111]">KiKi 默认 Skills</div>
          <div className="mt-1 max-w-[760px] text-[13px] leading-6 text-[#6B7280]">
            安装后会写入本机 Claude CLI skills 目录；KiKi 只管理 `kiki-*` 副本，不覆盖你的自定义 skills。
            安装 skill 不等于启用 Skill 工具，若要允许 Claude CLI 调用 skill，请在当前 Runtime 的工具权限策略中开启「子代理」能力。
          </div>
        </div>
        <div className="flex flex-none flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading || installing}
            className="inline-flex h-8 items-center gap-1 rounded-lg border border-[#E5E7EB] bg-white px-2.5 text-[12px] text-[#475467] hover:bg-[#F8F9FB] disabled:cursor-not-allowed disabled:opacity-70"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            刷新状态
          </button>
          <button
            type="button"
            onClick={onInstall}
            disabled={!canInstall}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#111] bg-[#111] px-3 text-[12px] text-white hover:bg-[#222] disabled:cursor-not-allowed disabled:opacity-70"
          >
            {installing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {installLabel}
          </button>
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-5">
        <InfoField label="目标目录" value={targetRoot} loading={loading && !status} />
        <InfoField label="已安装" value={String(status?.installed ?? 0)} loading={loading && !status} />
        <InfoField label="需更新" value={String(status?.outdated ?? 0)} loading={loading && !status} />
        <InfoField label="未安装" value={String(status?.notInstalled ?? 0)} loading={loading && !status} />
        <InfoField label="冲突" value={String(status?.blocked ?? 0)} loading={loading && !status} />
      </div>

      {status?.skills.length ? (
        <div className="mt-3 grid gap-2">
          {status.skills.map((skill) => {
            const statusLabel = kikiSkillStatusLabels[skill.status];
            return (
              <div
                key={skill.sourceSkillId}
                className="grid gap-2 rounded-xl border border-[#E5E7EB] bg-[#FAFAFB] px-3 py-2 md:grid-cols-[minmax(0,1fr)_auto]"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[12px] text-[#111]">{skill.targetName}</span>
                    <span className="text-[11px] text-[#6B7280]">v{skill.version}</span>
                    <span className={cn("rounded-full border px-2 py-1 text-[11px]", statusLabel.className)}>
                      {statusLabel.label}
                    </span>
                  </div>
                  <div className="mt-1 break-all text-[11px] leading-5 text-[#6B7280]">{skill.targetPath}</div>
                  {skill.reason ? (
                    <div className="mt-1 text-[11px] leading-5 text-[#B42318]">{skill.reason}</div>
                  ) : null}
                </div>
                <div className="self-center font-mono text-[10px] text-[#98A2B3]">{skill.contentHash.slice(0, 19)}...</div>
              </div>
            );
          })}
        </div>
      ) : null}

      {message ? (
        <div className="mt-3 rounded-2xl border border-[#BBF7D0] bg-[#F0FDF4] px-4 py-3 text-[12px] leading-5 text-[#166534]">
          {message}
        </div>
      ) : null}
      {error ? (
        <div className="mt-3 rounded-2xl border border-[#FECACA] bg-[#FEF2F2] px-4 py-3 text-[12px] leading-5 text-[#B42318]">
          <div>{error}</div>
          {error.includes("本机电脑") || error.includes("daemon") ? (
            <button
              type="button"
              onClick={onConnectMachine}
              className="mt-2 inline-flex h-8 items-center gap-1 rounded-lg border border-[#B42318] bg-white px-2.5 text-[12px] text-[#B42318] hover:bg-[#FEF2F2]"
            >
              <Monitor className="h-3.5 w-3.5" />
              连接本机电脑
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function ToolPolicySection({
  environment,
  onModeChange,
  onCapabilityChange,
  onAllowedToolRulesChange,
}: {
  environment: RuntimeEnvironment;
  onModeChange: (mode: RuntimeFilePolicyMode) => void;
  onCapabilityChange: (capability: RuntimeToolCapability, enabled: boolean) => void;
  onAllowedToolRulesChange: (rules: RuntimeToolPermissionRule[]) => void;
}) {
  const filePolicy = normalizeRuntimeFilePolicy(environment.filePolicy);
  const [newRulePattern, setNewRulePattern] = useState("");
  const allowedToolRules = filePolicy.allowedToolRules ?? [];

  const addAllowedRule = () => {
    const pattern = newRulePattern.trim();
    if (!pattern) return;
    if (allowedToolRules.some((rule) => rule.pattern === pattern)) {
      setNewRulePattern("");
      return;
    }
    const now = new Date().toISOString();
    onAllowedToolRulesChange([
      ...allowedToolRules,
      {
        id: `tool-rule-${Date.now().toString(36)}`,
        pattern,
        label: pattern,
        source: "user",
        createdAt: now,
      },
    ]);
    setNewRulePattern("");
  };

  const editAllowedRule = (rule: RuntimeToolPermissionRule) => {
    const nextPattern = window.prompt("修改工具规则", rule.pattern)?.trim();
    if (!nextPattern || nextPattern === rule.pattern) return;
    const nextRules = allowedToolRules.map((item) =>
      item.id === rule.id
        ? {
            ...item,
            pattern: nextPattern,
            label: item.label === item.pattern ? nextPattern : item.label,
            updatedAt: new Date().toISOString(),
          }
        : item,
    );
    onAllowedToolRulesChange(nextRules);
  };

  const removeAllowedRule = (rule: RuntimeToolPermissionRule) => {
    onAllowedToolRulesChange(allowedToolRules.filter((item) => item.id !== rule.id));
  };

  if (environment.runtimeKind === "codex") {
    return (
      <div className="mt-3 rounded-2xl border border-[#E5E7EB] bg-[#FAFAFB] px-4 py-3">
        <div className="text-[12px] font-medium text-[#111]">Codex sandbox 权限</div>
        <div className="mt-1 max-w-[620px] text-[12px] leading-5 text-[#6B7280]">
          Codex exec 首版不支持 Claude 式工具白名单，也不接 KiKi 手动确认弹窗；权限由 Codex sandbox 和执行权限模式控制。
        </div>
        <div className="mt-3 grid gap-2 md:grid-cols-3">
          <div className="rounded-xl border border-[#E5E7EB] bg-white px-3 py-2">
            <div className="text-[12px] font-medium text-[#111]">只读聊天</div>
            <div className="mt-1 text-[12px] leading-5 text-[#6B7280]">使用 read-only sandbox，可读项目，不写文件。</div>
          </div>
          <div className="rounded-xl border border-[#E5E7EB] bg-white px-3 py-2">
            <div className="text-[12px] font-medium text-[#111]">项目内可执行</div>
            <div className="mt-1 text-[12px] leading-5 text-[#6B7280]">使用 workspace-write sandbox，只允许在项目范围内执行和写入。</div>
          </div>
          <div className="rounded-xl border border-[#FDE68A] bg-[#FFFBEB] px-3 py-2">
            <div className="text-[12px] font-medium text-[#92400E]">手动确认不可用</div>
            <div className="mt-1 text-[12px] leading-5 text-[#92400E]">弹窗确认将在后续 app-server 阶段接入。</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-2xl border border-[#E5E7EB] bg-[#FAFAFB] px-4 py-3">
      <div className="grid items-start gap-4 md:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0">
          <div className="text-[12px] font-medium text-[#111]">工具权限策略</div>
          <div className="mt-1 max-w-[620px] text-[12px] leading-5 text-[#6B7280]">
            控制这个 Runtime 允许哪些工具能力。全部会话、目标模式、任务执行都会先遵循这里的设置。写入文件和终端命令还会受到「执行权限模式」约束；例如只读聊天下即使勾选，也不会真正生效。
          </div>
        </div>
        <div className="flex flex-nowrap items-center justify-end gap-2">
          {(["all_on", "all_off", "custom"] as RuntimeFilePolicyMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => onModeChange(mode)}
              className={cn(
                "rounded-full border px-3 py-1.5 text-[12px] transition",
                mode === filePolicy.mode
                  ? "border-[#111] bg-white text-[#111]"
                  : "border-[#E5E7EB] bg-white text-[#6B7280] hover:text-[#111]",
              )}
            >
              {filePolicyModeLabels[mode]}
            </button>
          ))}
        </div>
      </div>

      {filePolicy.mode === "custom" ? (
        <div className="mt-3 grid gap-2">
          {toolCapabilityOptions.map((option) => {
            const checked = filePolicy.custom[option.key];
            const constraint = capabilityConstraint(option.key, environment.permissionMode);
            return (
              <button
                key={option.key}
                type="button"
                onClick={() => onCapabilityChange(option.key, !checked)}
                className={cn(
                  "grid grid-cols-[auto_minmax(0,1fr)] items-start gap-2.5 rounded-xl border px-3 py-2 text-left transition",
                  checked ? "border-[#111] bg-white" : "border-[#E5E7EB] bg-white hover:border-[#D0D5DD]",
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 inline-flex h-[18px] w-[18px] items-center justify-center rounded-[5px] border text-[12px] leading-none",
                    checked ? "border-[#111] bg-[#111] text-white" : "border-[#D0D5DD] text-transparent",
                  )}
                >
                  ✓
                </span>
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-[12px] font-medium text-[#111]">{option.label}</span>
                    <span className="text-[11px] leading-5 text-[#6B7280]">{option.description}</span>
                    {option.tools.map((tool) => (
                      <span
                        key={tool}
                        className="inline-flex h-5 items-center rounded-full border border-[#E5E7EB] px-2 font-mono text-[10px] text-[#6B7280]"
                      >
                        {tool}
                      </span>
                    ))}
                  </span>
                  {constraint ? (
                    <span className="mt-1 block text-[10px] leading-4 text-[#B42318]">{constraint}</span>
                  ) : null}
                  {(option.key === "fileWrite" || option.key === "shell") && !checked ? (
                    <span className="mt-1 block text-[10px] leading-4 text-[#B54708]">
                      关闭后无法在会话中发送文件/附件
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
      <div className="mt-4 border-t border-[#E5E7EB] pt-3">
          <div className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center md:justify-between">
          <div>
            <div className="text-[12px] font-medium text-[#111]">额外允许的工具</div>
            <div className="mt-1 text-[11px] leading-5 text-[#6B7280]">
              运行时授权后沉淀的工具规则会显示在这里，可删除或修改。
            </div>
          </div>
            <div className="flex w-full min-w-0 flex-1 justify-end gap-2 md:min-w-[260px]">
            <input
              value={newRulePattern}
              onChange={(event) => setNewRulePattern(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") addAllowedRule();
              }}
              placeholder="例如 Workflow 或 mcp__server__*"
              className="h-8 min-w-0 flex-1 rounded-lg border border-[#E5E7EB] bg-white px-2.5 font-mono text-[12px] text-[#111] outline-none focus:border-[#111]"
            />
            <button
              type="button"
              onClick={addAllowedRule}
              className="h-8 rounded-lg border border-[#111] bg-white px-3 text-[12px] text-[#111] hover:bg-[#F8F9FB]"
            >
              添加
            </button>
          </div>
        </div>
        {allowedToolRules.length > 0 ? (
          <div className="mt-2 grid gap-2">
            {allowedToolRules.map((rule) => (
              <div
                key={rule.id}
                className="flex items-center gap-2 rounded-xl border border-[#E5E7EB] bg-white px-3 py-2"
              >
                <span className="min-w-0 flex-1 break-all font-mono text-[12px] text-[#111]">{rule.pattern}</span>
                <button
                  type="button"
                  onClick={() => editAllowedRule(rule)}
                  className="rounded-lg border border-[#E5E7EB] px-2 py-1 text-[11px] text-[#475467] hover:bg-[#F8F9FB]"
                >
                  编辑
                </button>
                <button
                  type="button"
                  onClick={() => removeAllowedRule(rule)}
                  className="rounded-lg border border-[#FECACA] px-2 py-1 text-[11px] text-[#B42318] hover:bg-[#FEF2F2]"
                >
                  删除
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-2 text-[11px] text-[#9CA3AF]">暂无额外允许工具。</div>
        )}
      </div>
    </div>
  );
}

function InfoField({
  label,
  value,
  loading = false,
}: {
  label: string;
  value: string;
  loading?: boolean;
}) {
  return (
    <div className="rounded-2xl border border-[#E5E7EB] bg-white px-4 py-3">
      <div className="text-[12px] text-[#6B7280]">{label}</div>
      {loading ? (
        <div className="mt-2 flex items-center gap-2 text-[13px] text-[#6B7280]">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>加载中...</span>
        </div>
      ) : (
        <div className="mt-1 break-all text-[14px] text-[#111]">{value}</div>
      )}
    </div>
  );
}

function EnableDaemonConfirmDialog({
  open,
  environmentName,
  remote,
  pending,
  onClose,
  onConfirm,
}: {
  open: boolean;
  environmentName: string;
  remote: boolean;
  pending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/30" onClick={onClose}>
      <div
        className="w-[520px] max-w-[92vw] rounded-2xl border border-[#E5E7EB] bg-white"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="border-b border-[#E5E7EB] px-5 py-4">
          <div className="text-[15px] font-medium text-[#111]">开启 24h 运行</div>
          <div className="mt-1 text-[13px] leading-6 text-[#6B7280]">
            {remote ? (
              <>
                即将通过已连接的本机 daemon 为 <span className="font-medium text-[#111]">{environmentName}</span>{" "}
                注册系统后台服务。安装后，KiKi 会在本机后台持续连接云端，关闭浏览器或云端页面也可以继续执行任务。
              </>
            ) : (
              <>
                即将为 <span className="font-medium text-[#111]">{environmentName}</span> 安装 macOS LaunchAgent。安装后，
                KiKi 会在你登录系统后自动拉起本机 Runtime Daemon，关闭浏览器也可以继续执行任务。
              </>
            )}
          </div>
        </div>
        <div className="space-y-2 px-5 py-4 text-[13px] leading-6 text-[#475467]">
          {remote ? (
            <>
              <div>1. macOS 会写入 `~/Library/LaunchAgents/com.kiki.daemon.plist`</div>
              <div>2. Linux 会写入 user systemd unit，并启动 `kiki-daemon` 后台服务</div>
              <div>3. 开启成功后请关闭当前前台 `kiki-daemon run` 终端，避免双进程抢占</div>
            </>
          ) : (
            <>
              <div>1. 会写入 `~/Library/LaunchAgents/com.kiki.runtime-daemon.plist`</div>
              <div>2. 会调用 `launchctl` 注册并启动系统常驻进程</div>
              <div>3. 之后你仍然可以随时关闭这个开关来停用常驻能力</div>
            </>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-[#E5E7EB] px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className="inline-flex h-9 items-center rounded-lg border border-[#E5E7EB] bg-white px-3 text-[13px] text-[#111] hover:bg-[#F8F9FB]"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-[#111] px-3 text-[13px] text-white hover:bg-[#222]"
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            确认安装并开启
          </button>
        </div>
      </div>
    </div>
  );
}

"use client";

import { Laptop, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  fetchRuntimeDaemonStatus,
  setRuntimeDaemonAutoStart,
  type RuntimeDaemonStatusPayload,
} from "@/lib/api/runtime-daemon";
import { getRuntimeEnvStatus } from "@/lib/api/runtime-envs";
import { cn } from "@/lib/utils";
import { useRuntimeEnvStore } from "@/stores/runtimeEnvStore";
import type { LocalRuntimeKind, RuntimeEnvironment, RuntimePermissionMode } from "@/types/runtime";

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
};

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

export function RuntimeEnvironmentPanel() {
  const environments = useRuntimeEnvStore((state) => state.environments);
  const addEnvironment = useRuntimeEnvStore((state) => state.addEnvironment);
  const setEnvironmentHealth = useRuntimeEnvStore((state) => state.setEnvironmentHealth);
  const setActiveEnvironment = useRuntimeEnvStore((state) => state.setActiveEnvironment);
  const setPermissionMode = useRuntimeEnvStore((state) => state.setPermissionMode);
  const removeEnvironment = useRuntimeEnvStore((state) => state.removeEnvironment);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [daemonStatus, setDaemonStatus] = useState<RuntimeDaemonStatusPayload | null>(null);
  const [daemonActionMessage, setDaemonActionMessage] = useState<string | null>(null);
  const [daemonActionError, setDaemonActionError] = useState<string | null>(null);
  const [daemonSwitchPending, setDaemonSwitchPending] = useState(false);
  const [confirm24hOpen, setConfirm24hOpen] = useState(false);
  const [optimisticDaemonEnabled, setOptimisticDaemonEnabled] = useState<boolean | null>(null);
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

  const refreshEnvironment = useCallback(async (environment: RuntimeEnvironment) => {
    setEnvironmentHealth(environment.id, { status: "checking" });
    try {
      const result = await getRuntimeEnvStatus({
        workingDirectory: environment.workingDirectory,
        cliPath: environment.cliPath,
        runtimeKind: environment.runtimeKind || "claude",
      });
      setEnvironmentHealth(environment.id, {
        status: "online",
        cliPath: result.cliPath,
        claudeVersion: result.version,
      });
      if (result.cliPath !== environment.cliPath) {
        useRuntimeEnvStore.getState().updateEnvironment(environment.id, { cliPath: result.cliPath });
      }
    } catch (error) {
      setEnvironmentHealth(environment.id, {
        status: "offline",
        reason: error instanceof Error ? error.message : "环境状态检测失败",
      });
    }
  }, [setEnvironmentHealth]);

  useEffect(() => {
    const localEnvironments = environments.filter((item) => item.type === "local");
    localEnvironments.forEach((environment) => {
      if (environment.health?.status === "online" || environment.health?.status === "checking") return;
      void refreshEnvironment(environment);
    });
  }, [environments, refreshEnvironment]);

  const loadDaemonStatus = useCallback(async () => {
    const next = await fetchRuntimeDaemonStatus();
    setDaemonStatus(next);
    return next;
  }, []);

  const daemonEnabled = Boolean(daemonStatus?.config?.autoStart && daemonStatus?.launchAgentInstalled);
  const effectiveDaemonEnabled = optimisticDaemonEnabled ?? daemonEnabled;

  const applyDaemonToggle = useCallback(async (enabled: boolean) => {
    if (enabled && !activeLocalEnvironment) {
      setDaemonActionError("请先连接一个本地 Runtime 环境，再开启 24h 运行");
      return;
    }

    setDaemonSwitchPending(true);
    setOptimisticDaemonEnabled(enabled);
    setDaemonActionMessage(null);
    setDaemonActionError(null);
    try {
      await setRuntimeDaemonAutoStart(
        enabled
          ? {
              enabled: true,
              environment: {
                name: activeLocalEnvironment?.name || "KiKi Local Runtime",
                workingDirectory: activeLocalEnvironment?.workingDirectory || "",
                cliPath: activeLocalEnvironment?.cliPath || "claude",
                permissionMode: activeLocalEnvironment?.permissionMode || "confirm",
              },
            }
          : { enabled: false },
      );
      await loadDaemonStatus();
      setDaemonActionMessage(
        enabled
          ? "24h 运行已开启，系统会为当前本地 Runtime 安装并启动 LaunchAgent。"
          : "24h 运行已关闭，系统常驻 LaunchAgent 已停用。",
      );
    } catch (error) {
      setOptimisticDaemonEnabled(null);
      setDaemonActionError(error instanceof Error ? error.message : "24h 运行设置失败");
    } finally {
      setOptimisticDaemonEnabled(null);
      setDaemonSwitchPending(false);
    }
  }, [activeLocalEnvironment, loadDaemonStatus]);

  useEffect(() => {
    let cancelled = false;
    const safeLoadDaemonStatus = async () => {
      try {
        const next = await fetchRuntimeDaemonStatus();
        if (!cancelled) setDaemonStatus(next);
      } catch {
        if (!cancelled) setDaemonStatus(null);
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

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-[#E5E7EB] bg-white px-5 py-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[15px] font-medium text-[#111]">连接 Runtime</div>
            <div className="mt-1 text-[13px] text-[#6B7280]">
              添加云端 Runtime 环境或本地环境，让 KiKi 助手和会话页连接到你的设备。
            </div>
          </div>
          <div className="flex flex-none items-center gap-2">
            <button
              type="button"
              disabled
              className="inline-flex h-9 min-w-[128px] shrink-0 cursor-not-allowed items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-[#E5E7EB] bg-[#F8F9FB] px-3 text-[13px] text-[#9AA0A6]"
            >
              <Plus className="h-4 w-4" />
              添加云端 Runtime
            </button>
            <button
              type="button"
              onClick={() => setWizardOpen(true)}
              className="inline-flex h-9 min-w-[128px] shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-[#111] bg-[#111] px-3 text-[13px] text-white hover:bg-[#222]"
            >
              <Plus className="h-4 w-4" />
              添加本地环境
            </button>
          </div>
        </div>
      </section>

      {wizardOpen ? (
        <LocalRuntimeWizard
          open={wizardOpen}
          onClose={() => setWizardOpen(false)}
          onSave={(environment) => {
            const next = addEnvironment(environment);
            setActiveEnvironment(next.id);
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
                      const ok = window.confirm(`删除本地环境「${environment.name}」？`);
                      if (!ok) return;
                      removeEnvironment(environment.id);
                    }}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[#E5E7EB] bg-white text-[#B42318] hover:bg-[#FEF2F2]"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                ) : null}
                {!environment.isDefault ? (
                  <button
                    type="button"
                    onClick={() => setActiveEnvironment(environment.id)}
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
                <div className="text-[12px] text-[#6B7280]">权限模式</div>
                <div className="mt-1 text-[13px] text-[#111]">
                  {permissionLabels[environment.permissionMode]}
                </div>
              </div>
              {environment.type === "local" ? (
                <div className="ml-auto flex items-center gap-2">
                  {(["readonly", "confirm", "execute"] as RuntimePermissionMode[]).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setPermissionMode(environment.id, mode)}
                      className={cn(
                        "rounded-full border px-3 py-1.5 text-[12px] transition",
                        mode === environment.permissionMode
                          ? "border-[#111] bg-white text-[#111]"
                          : "border-[#E5E7EB] bg-white text-[#6B7280] hover:text-[#111]",
                      )}
                    >
                      {permissionLabels[mode]}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            {environment.type === "local" ? (
              environment.isDefault ? (
                <div className="mt-3 rounded-2xl border border-[#E5E7EB] bg-[#FAFAFB] px-4 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="text-[13px] font-medium text-[#111]">24h 运行</div>
                        <span className="rounded-full border border-[#E5E7EB] px-2 py-1 text-[11px] text-[#111]">
                          {daemonSwitchPending ? (
                            <span className="inline-flex items-center gap-1">
                              <Loader2 className="h-3 w-3 animate-spin" />
                              加载中
                            </span>
                          ) : effectiveDaemonEnabled ? (
                            daemonStatus?.state?.status === "running" ? "运行中" : daemonStatus?.state?.status === "error" ? "异常" : "待机"
                          ) : "已关闭"}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            setDaemonActionMessage(null);
                            setDaemonActionError(null);
                            void loadDaemonStatus().catch(() => {
                              setDaemonActionError("本地 Runtime Daemon 状态获取失败");
                            });
                          }}
                          disabled={daemonSwitchPending}
                          className="inline-flex h-7 items-center gap-1 rounded-full border border-[#E5E7EB] bg-white px-2.5 text-[11px] text-[#475467] hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          <RefreshCw className={cn("h-3.5 w-3.5", daemonSwitchPending && "animate-spin")} />
                          刷新状态
                        </button>
                      </div>
                      <div className="mt-1 text-[12px] leading-5 text-[#6B7280]">
                        为当前本地 Runtime 安装系统常驻守护，关闭浏览器后依然可以继续调度任务。默认关闭，首次开启时会提示你确认安装
                        LaunchAgent；关闭后会自动停用系统常驻。
                      </div>
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
                        label="LaunchAgent"
                        value={daemonStatus?.launchAgentInstalled ? "已安装" : "未安装"}
                        loading={daemonSwitchPending}
                      />
                      <InfoField
                        label="LaunchAgent 路径"
                        value={daemonStatus?.launchAgentPath || "暂无"}
                        loading={daemonSwitchPending}
                      />
                    </div>
                  ) : null}

                  {daemonActionMessage ? (
                    <div className="mt-3 rounded-2xl border border-[#BBF7D0] bg-[#F0FDF4] px-4 py-3 text-[12px] leading-5 text-[#166534]">
                      {daemonActionMessage}
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

      <EnableDaemonConfirmDialog
        open={confirm24hOpen}
        environmentName={activeLocalEnvironment?.name || "当前本地 Runtime"}
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
  pending,
  onClose,
  onConfirm,
}: {
  open: boolean;
  environmentName: string;
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
            即将为 <span className="font-medium text-[#111]">{environmentName}</span> 安装 macOS LaunchAgent。安装后，
            KiKi 会在你登录系统后自动拉起本机 Runtime Daemon，关闭浏览器也可以继续执行任务。
          </div>
        </div>
        <div className="space-y-2 px-5 py-4 text-[13px] leading-6 text-[#475467]">
          <div>1. 会写入 `~/Library/LaunchAgents/com.kiki.runtime-daemon.plist`</div>
          <div>2. 会调用 `launchctl` 注册并启动系统常驻进程</div>
          <div>3. 之后你仍然可以随时关闭这个开关来停用常驻能力</div>
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

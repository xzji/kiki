"use client";

import { Cloud, Laptop, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

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

export function RuntimeEnvironmentPanel() {
  const environments = useRuntimeEnvStore((state) => state.environments);
  const addEnvironment = useRuntimeEnvStore((state) => state.addEnvironment);
  const setEnvironmentHealth = useRuntimeEnvStore((state) => state.setEnvironmentHealth);
  const setActiveEnvironment = useRuntimeEnvStore((state) => state.setActiveEnvironment);
  const setPermissionMode = useRuntimeEnvStore((state) => state.setPermissionMode);
  const removeEnvironment = useRuntimeEnvStore((state) => state.removeEnvironment);
  const [wizardOpen, setWizardOpen] = useState(false);
  const visibleEnvironments = environments.filter((environment) => environment.type !== "cloud");

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

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[15px] font-medium text-[#111]">运行环境</div>
          <div className="mt-1 text-[13px] text-[#6B7280]">
            通过本地 Claude CLI 让 KiKi 助手和会话页真正连接到你的电脑。
          </div>
        </div>
        <div className="flex flex-none items-center gap-2">
          <button
            type="button"
            disabled
            className="inline-flex h-9 min-w-[128px] shrink-0 cursor-not-allowed items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-[#E5E7EB] bg-[#F8F9FB] px-3 text-[13px] text-[#9AA0A6]"
          >
            <Plus className="h-4 w-4" />
            添加云端环境
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
                    {environment.type === "cloud" ? (
                      <Cloud className="h-4 w-4" />
                    ) : (
                      <Laptop className="h-4 w-4" />
                    )}
                  </span>
                  <div className="min-w-0">
                    <div className="truncate text-[14px] font-medium text-[#111]">
                      {environment.name}
                    </div>
                    <div className="mt-0.5 text-[12px] text-[#6B7280]">
                      {environment.type === "cloud"
                        ? "云端环境"
                        : runtimeKindLabels[environment.runtimeKind || "claude"]}
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
                label={environment.type === "cloud" ? "云端工作区" : "工作目录"}
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

            {environment.health && "reason" in environment.health ? (
              <div className="mt-3 text-[12px] leading-5 text-[#B42318]">
                {environment.health.reason}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function InfoField({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-[#E5E7EB] bg-white px-4 py-3">
      <div className="text-[12px] text-[#6B7280]">{label}</div>
      <div className="mt-1 break-all text-[14px] text-[#111]">{value}</div>
    </div>
  );
}

"use client";

import { Brain, Lock, RotateCcw, SlidersHorizontal, Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";

import {
  EASTER_EGG_SETTING_META,
  type EasterEggSettings,
  type GoalDrivenLogMode,
  type GoalDrivenUiLogLevel,
  type NumericSettingKey,
} from "@/lib/goalSystemConfig";
import { cn } from "@/lib/utils";
import type { SettingsTab } from "@/lib/settings";
import { setRuntimeDaemonMaxConcurrentTasks } from "@/lib/api/runtime-daemon";
import { useEasterEggSettingsStore } from "@/stores/easterEggSettingsStore";
import { MemoryEditor } from "@/components/memory/MemoryEditor";

import { BackendLogsPanel } from "./BackendLogsPanel";
import { RuntimeEnvironmentPanel } from "./RuntimeEnvironmentPanel";

type SettingsUser = {
  id: string;
  email: string;
  displayName: string;
};

export function SettingsModal({
  open,
  user,
  defaultTab = "account",
  onClose,
}: {
  open: boolean;
  user: SettingsUser | null;
  defaultTab?: SettingsTab;
  onClose: () => void;
}) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(defaultTab);
  const settingsHydrated = useEasterEggSettingsStore((state) => state.hydrated);
  const settings = useEasterEggSettingsStore((state) => state.settings);
  const hydrateSettings = useEasterEggSettingsStore((state) => state.hydrate);
  const updateNumericSetting = useEasterEggSettingsStore((state) => state.updateNumericSetting);
  const updateLogMode = useEasterEggSettingsStore((state) => state.updateLogMode);
  const updateUiLogLevel = useEasterEggSettingsStore((state) => state.updateUiLogLevel);
  const resetToDefaults = useEasterEggSettingsStore((state) => state.resetToDefaults);

  // maxConcurrentTasks 是 daemon 执行并发的权威配置，改动后需同步到服务端。
  const handleNumericChange = (key: NumericSettingKey, value: number) => {
    updateNumericSetting(key, value);
    if (key === "maxConcurrentTasks") {
      void setRuntimeDaemonMaxConcurrentTasks(Math.round(value)).catch(() => {
        // 同步失败不阻断本地设置；TaskMonitor 抽屉会兜底再次同步。
      });
    }
  };

  useEffect(() => {
    if (!open) return;
    setActiveTab(defaultTab);
  }, [defaultTab, open]);

  useEffect(() => {
    hydrateSettings();
  }, [hydrateSettings]);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20" onClick={onClose}>
      <div
        className="relative flex h-[88vh] max-h-[920px] w-[1080px] max-w-[96vw] overflow-hidden rounded-2xl border border-[#E5E7EB] bg-white"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭设置"
          className="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-md text-[#6B7280] hover:bg-[#F5F6F8] hover:text-[#111]"
        >
          <X className="h-4 w-4" />
        </button>
        <div className="flex w-[148px] flex-none flex-col border-r border-[#E5E7EB] bg-[#FBFBFC] px-4 py-4">
          <div className="mb-5 flex items-center px-2">
            <div className="text-[15px] font-medium text-[#111]">设置</div>
          </div>
          <div className="space-y-1">
            <SettingsNavItem
              active={activeTab === "account"}
              label="账号"
              onClick={() => setActiveTab("account")}
            />
            <SettingsNavItem
              active={activeTab === "runtime"}
              label="运行环境"
              onClick={() => setActiveTab("runtime")}
            />
            <SettingsNavItem
              active={activeTab === "memory"}
              label="记忆"
              onClick={() => setActiveTab("memory")}
            />
          </div>
          <div className="mt-auto pt-4">
            <button
              type="button"
              onClick={() => setActiveTab("easter-egg")}
              className={cn(
                "flex w-full items-center gap-2 rounded-xl border border-dashed px-3 py-2 text-left text-[12px] transition-colors",
                activeTab === "easter-egg"
                  ? "border-[#D6CCFF] bg-white text-[#5B3DBE]"
                  : "border-[#E5E7EB] text-[#6B7280] hover:border-[#D6CCFF] hover:bg-white hover:text-[#5B3DBE]",
              )}
            >
              <Sparkles className="h-3.5 w-3.5" />
              <span>彩蛋设置</span>
            </button>
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-14 flex-none items-center border-b border-[#E5E7EB] px-6">
            <div className="text-[15px] font-medium text-[#111]">
              {activeTab === "account"
                ? "账号"
                : activeTab === "runtime"
                  ? "运行环境"
                  : activeTab === "memory"
                    ? "记忆"
                    : "彩蛋设置"}
            </div>
          </div>
          <div className="flex-1 overflow-y-auto overscroll-contain px-6 py-6">
            {activeTab === "account" ? <AccountPanel user={user} /> : null}
            {activeTab === "runtime" ? <RuntimeEnvironmentPanel /> : null}
            {activeTab === "memory" ? <UserMemoryPanel /> : null}
            {activeTab === "easter-egg" ? (
              <EasterEggSettingsPanel
                hydrated={settingsHydrated}
                settings={settings}
                onNumericChange={handleNumericChange}
                onLogModeChange={updateLogMode}
                onUiLogLevelChange={updateUiLogLevel}
                onReset={resetToDefaults}
              />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function UserMemoryPanel() {
  return (
    <div className="h-full min-h-[480px] max-w-[760px]">
      <div className="mb-4 flex items-center gap-2 text-[13px] text-[#6B7280]">
        <Brain className="h-4 w-4 text-[#5B3DBE]" />
        <span>用户长期记忆会跨会话注入，用于保存稳定偏好和长期事实。</span>
      </div>
      <MemoryEditor
        endpoint="/api/memory/profile"
        title="用户记忆"
        description="这里管理 M2 用户长期记忆。内容会在新会话中作为用户画像注入，但不会跟随单个会话删除。"
        limitLabel="24KB"
      />
    </div>
  );
}

function AccountPanel({ user }: { user: SettingsUser | null }) {
  const displayName = user?.displayName.trim() || "用户";
  const email = user?.email.trim() || "正在读取当前账号信息";
  const initial = displayName.charAt(0).toUpperCase() || "U";

  return (
    <div className="w-full space-y-5">
      <div className="flex w-full items-center justify-between gap-6 rounded-2xl border border-[#E5E7EB] bg-white px-6 py-6">
        <div className="flex min-w-0 items-center gap-4">
          <div className="flex h-16 w-16 flex-none items-center justify-center rounded-full border border-[#D0D7DE] bg-[#E9E6FF] text-lg font-medium text-[#5F5AA2]">
            {initial}
          </div>
          <div className="min-w-0">
            <div className="truncate text-[17px] font-medium text-[#111]">{displayName}</div>
            <div className="mt-1 truncate text-[13px] text-[#6B7280]">{email}</div>
          </div>
        </div>
        <div className="flex-none rounded-full border border-[#E5E7EB] bg-[#FAFAFB] px-3 py-1 text-[12px] text-[#4B5563]">
          KiKi Agent 账户
        </div>
      </div>
      <div className="grid w-full grid-cols-2 gap-4">
        <InfoField label="昵称" value={displayName} />
        <InfoField label="绑定邮箱" value={email} />
      </div>
    </div>
  );
}

function SettingsNavItem({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center rounded-xl px-3 py-2 text-left text-[13px] text-[#4B5563] hover:bg-white",
        active && "bg-white font-medium text-[#111]",
      )}
    >
      {label}
    </button>
  );
}

function InfoField({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-[#E5E7EB] bg-white px-5 py-4">
      <div className="text-[12px] text-[#6B7280]">{label}</div>
      <div className="mt-1 break-all text-[14px] text-[#111]">{value}</div>
    </div>
  );
}

function EasterEggSettingsPanel({
  hydrated,
  settings,
  onNumericChange,
  onLogModeChange,
  onUiLogLevelChange,
  onReset,
}: {
  hydrated: boolean;
  settings: EasterEggSettings;
  onNumericChange: (key: NumericSettingKey, value: number) => void;
  onLogModeChange: (value: GoalDrivenLogMode) => void;
  onUiLogLevelChange: (value: GoalDrivenUiLogLevel) => void;
  onReset: () => void;
}) {
  if (!hydrated) {
    return <div className="text-sm text-[#6B7280]">正在加载隐藏配置...</div>;
  }

  const activeSettingKeys: NumericSettingKey[] = [
    "maxConcurrentTasks",
    "minInfoCollectionRounds",
    "maxInfoCollectionRounds",
    "schedulerCycleIntervalMs",
    "taskDefaultTimeoutMs",
    "taskHeartbeatTimeoutMs",
    "minSubGoals",
    "maxSubGoals",
    "minTasksPerSubGoal",
    "maxTasksPerSubGoal",
  ];

  const reservedSettingKeys: NumericSettingKey[] = [
    "logBufferMaxSize",
  ];

  return (
    <div className="max-w-[680px] space-y-6">
      <div className="rounded-2xl border border-[#E9D8FD] bg-[#FAF5FF] px-5 py-4">
        <div className="flex items-center gap-2 text-[14px] font-medium text-[#5B3DBE]">
          <Sparkles className="h-4 w-4" />
          <span>产品彩蛋</span>
        </div>
        <div className="mt-2 text-[13px] leading-6 text-[#6B4F8C]">
          这里放的是偏实验性和内部使用的系统阈值。当前浏览器保存后会立即影响 `/goal` 的信息收集、目标规划拆解，以及确认规划后的自动执行调度。
        </div>
      </div>

      <div className="rounded-2xl border border-[#E5E7EB] bg-white px-5 py-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-[15px] font-medium text-[#111]">
              <SlidersHorizontal className="h-4 w-4 text-[#5B3DBE]" />
              <span>当前已生效</span>
            </div>
            <div className="mt-1 text-[13px] text-[#6B7280]">
              修改后会影响 collecting_info 轮次、目标规划 prompt 拆解范围，以及真实 scheduler 的并发与调度节奏。
            </div>
          </div>
          <button
            type="button"
            onClick={onReset}
            className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg border border-[#D0D7DE] px-3 py-2 text-[12px] font-medium text-[#374151] hover:border-[#111] hover:text-[#111]"
          >
            <RotateCcw className="h-3.5 w-3.5 shrink-0" />
            <span className="whitespace-nowrap">恢复默认</span>
          </button>
        </div>
        <div className="mt-5 space-y-4">
          {activeSettingKeys.map((key) => (
            <NumericSettingField
              key={key}
              label={EASTER_EGG_SETTING_META[key].label}
              description={EASTER_EGG_SETTING_META[key].description}
              value={settings[key]}
              min={EASTER_EGG_SETTING_META[key].min ?? 0}
              max={EASTER_EGG_SETTING_META[key].max ?? 10}
              unit={EASTER_EGG_SETTING_META[key].displayUnit}
              displayScale={EASTER_EGG_SETTING_META[key].displayScale}
              active
              onChange={(value) => onNumericChange(key, value)}
            />
          ))}
        </div>
      </div>

      <div className="rounded-2xl border border-[#E5E7EB] bg-white px-5 py-5">
        <div className="flex items-center gap-2 text-[15px] font-medium text-[#111]">
          <Lock className="h-4 w-4 text-[#6B7280]" />
          <span>与 coding-agent 对齐的预留项</span>
        </div>
        <div className="mt-1 text-[13px] text-[#6B7280]">
          这些配置已经持久化，其中大部分仍作为后续执行监控和调试能力的预留项。
        </div>
        <div className="mt-5 space-y-4">
          {reservedSettingKeys.map((key) => (
            <NumericSettingField
              key={key}
              label={EASTER_EGG_SETTING_META[key].label}
              description={EASTER_EGG_SETTING_META[key].description}
              value={settings[key]}
              min={EASTER_EGG_SETTING_META[key].min ?? 0}
              max={EASTER_EGG_SETTING_META[key].max ?? 10}
              unit={EASTER_EGG_SETTING_META[key].displayUnit}
              displayScale={EASTER_EGG_SETTING_META[key].displayScale}
              active={false}
              onChange={(value) => onNumericChange(key, value)}
            />
          ))}
          <EnumSettingField
            label={EASTER_EGG_SETTING_META.llmLogMode.label}
            description={EASTER_EGG_SETTING_META.llmLogMode.description}
            value={settings.llmLogMode}
            options={[
              { value: "minimal", label: "minimal" },
              { value: "standard", label: "standard" },
              { value: "verbose", label: "verbose" },
            ]}
            active={false}
            onChange={(value) => onLogModeChange(value as GoalDrivenLogMode)}
          />
          <EnumSettingField
            label={EASTER_EGG_SETTING_META.uiLogLevel.label}
            description={EASTER_EGG_SETTING_META.uiLogLevel.description}
            value={settings.uiLogLevel}
            options={[
              { value: "none", label: "none" },
              { value: "error", label: "error" },
              { value: "warn", label: "warn" },
              { value: "info", label: "info" },
              { value: "debug", label: "debug" },
            ]}
            active={false}
            onChange={(value) => onUiLogLevelChange(value as GoalDrivenUiLogLevel)}
          />
        </div>
      </div>

      <BackendLogsPanel />
    </div>
  );
}

function NumericSettingField({
  label,
  description,
  value,
  min,
  max,
  unit,
  displayScale,
  active,
  onChange,
}: {
  label: string;
  description: string;
  value: number;
  min: number;
  max: number;
  unit?: string;
  displayScale?: number;
  active: boolean;
  onChange: (value: number) => void;
}) {
  const scale = displayScale ?? 1;
  const displayValue = Math.round(value / scale);
  const displayMin = Math.round(min / scale);
  const displayMax = Math.round(max / scale);
  const handleDisplayValueChange = (rawValue: number) => {
    onChange(rawValue * scale);
  };

  return (
    <div className="rounded-2xl border border-[#E5E7EB] bg-[#FCFCFD] px-4 py-4">
      <div className="flex items-start gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <div className="text-[14px] font-medium text-[#111]">{label}</div>
            {unit ? <span className="rounded-full bg-[#F3F4F6] px-2 py-0.5 text-[11px] text-[#6B7280]">{unit}</span> : null}
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[11px]",
                active ? "bg-[#EEF4FF] text-[#175CD3]" : "bg-[#F3F4F6] text-[#6B7280]",
              )}
            >
              {active ? "已生效" : "预留"}
            </span>
          </div>
          <div className="mt-1 text-[12px] leading-5 text-[#6B7280]">{description}</div>
        </div>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <input
          type="range"
          min={displayMin}
          max={displayMax}
          step={1}
          value={displayValue}
          onChange={(event) => handleDisplayValueChange(Number(event.target.value))}
          className="h-2 flex-1 accent-[#5B3DBE]"
        />
        <div className="relative w-24 shrink-0">
          <input
            type="number"
            min={displayMin}
            max={displayMax}
            value={displayValue}
            onChange={(event) => handleDisplayValueChange(Number(event.target.value))}
            className={cn(
              "w-full rounded-lg border border-[#D0D7DE] py-1.5 text-[12px] text-[#111] outline-none focus:border-[#5B3DBE]",
              unit ? "px-2 pr-9" : "px-2",
            )}
          />
          {unit ? (
            <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-[11px] text-[#9CA3AF]">
              {unit}
            </span>
          ) : null}
        </div>
      </div>
      <div className="mt-2 text-[11px] text-[#9CA3AF]">
        范围 {displayMin} - {displayMax}
        {unit ? ` ${unit}` : ""}
      </div>
    </div>
  );
}

function EnumSettingField({
  label,
  description,
  value,
  options,
  active,
  onChange,
}: {
  label: string;
  description: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  active: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="rounded-2xl border border-[#E5E7EB] bg-[#FCFCFD] px-4 py-4">
      <div className="flex items-center gap-2">
        <div className="text-[14px] font-medium text-[#111]">{label}</div>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[11px]",
            active ? "bg-[#EEF4FF] text-[#175CD3]" : "bg-[#F3F4F6] text-[#6B7280]",
          )}
        >
          {active ? "已生效" : "预留"}
        </span>
      </div>
      <div className="mt-1 text-[12px] leading-5 text-[#6B7280]">{description}</div>
      <div className="mt-4 grid grid-cols-3 gap-2">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={cn(
              "rounded-xl border px-3 py-2 text-[12px] transition-colors",
              value === option.value
                ? "border-[#5B3DBE] bg-[#F4F0FF] text-[#5B3DBE]"
                : "border-[#E5E7EB] bg-white text-[#4B5563] hover:border-[#D6CCFF] hover:text-[#5B3DBE]",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

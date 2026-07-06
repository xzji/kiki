"use client";

import { Atom, Bot, CheckCircle2, Code2, FolderOpen, Loader2, MousePointer2, Sparkles, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { checkRuntimeEnv, discoverRuntimeEnvs, selectRuntimeWorkingDirectory } from "@/lib/api/runtime-envs";
import { cn } from "@/lib/utils";
import { DEFAULT_RUNTIME_FILE_POLICY } from "@/types/runtime";
import type {
  LocalRuntimeKind,
  RuntimeEnvironment,
  RuntimeEnvironmentCheckResult,
  RuntimeDiscoveryItem,
  RuntimePermissionMode,
} from "@/types/runtime";

type Props = {
  open: boolean;
  onClose: () => void;
  onSave: (environment: Omit<RuntimeEnvironment, "id">) => void;
};

const permissionOptions: { value: RuntimePermissionMode; label: string; description: string }[] = [
  { value: "readonly", label: "只读聊天", description: "只用于问答，不允许 Runtime 改动项目" },
  { value: "confirm", label: "手动确认", description: "遇到需要工具权限的操作时在 KiKi 中确认，并同步写入 Cursor CLI 权限配置" },
  { value: "execute", label: "项目内可执行", description: "默认模式，允许 Runtime 在当前项目目录内执行工具能力" },
];

const runtimeMeta: Record<LocalRuntimeKind, { accent: string; icon: ReactNode }> = {
  claude: { accent: "bg-brand-bg text-brand", icon: <Sparkles className="h-4 w-4" /> },
  codex: { accent: "bg-info-bg text-info", icon: <Code2 className="h-4 w-4" /> },
  gemini: { accent: "bg-success-bg text-success", icon: <Bot className="h-4 w-4" /> },
  pi: { accent: "bg-danger-bg text-danger-strong", icon: <Atom className="h-4 w-4" /> },
  cursor: { accent: "bg-brand-bg text-brand", icon: <MousePointer2 className="h-4 w-4" /> },
};

const runtimeIconByName: Record<string, ReactNode> = {
  Atom: <Atom className="h-4 w-4" />,
  Bot: <Bot className="h-4 w-4" />,
  Code2: <Code2 className="h-4 w-4" />,
  MousePointer2: <MousePointer2 className="h-4 w-4" />,
  Sparkles: <Sparkles className="h-4 w-4" />,
};

function getRuntimeMeta(runtime: RuntimeDiscoveryItem) {
  const fallback = runtimeMeta[runtime.runtimeKind];
  return {
    accent: runtime.uiAccent || fallback.accent,
    icon: runtime.uiIcon ? runtimeIconByName[runtime.uiIcon] ?? fallback.icon : fallback.icon,
  };
}

type WizardStep = "scan" | "select" | "permission" | "confirm";

export function LocalRuntimeWizard({ open, onClose, onSave }: Props) {
  const [step, setStep] = useState<WizardStep>("scan");
  const [runtimes, setRuntimes] = useState<RuntimeDiscoveryItem[]>([]);
  const [selectedRuntime, setSelectedRuntime] = useState<RuntimeDiscoveryItem | null>(null);
  const [workingDirectory, setWorkingDirectory] = useState("");
  const [permissionMode, setPermissionMode] = useState<RuntimePermissionMode>("execute");
  const [isScanning, setIsScanning] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const [isSelectingDirectory, setIsSelectingDirectory] = useState(false);
  const [showManualDirectoryInput, setShowManualDirectoryInput] = useState(false);
  const [manualDirectoryDraft, setManualDirectoryDraft] = useState("");
  const [result, setResult] = useState<RuntimeEnvironmentCheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const steps = useMemo(
    () => [
      { key: "scan", label: "扫描 Runtime" },
      { key: "select", label: "选择 Runtime" },
      { key: "permission", label: "确认权限" },
      { key: "confirm", label: "最终确认" },
    ],
    [],
  );

  const installedRuntimes = runtimes.filter((item) => item.installed);

  const selectRuntime = (runtime: RuntimeDiscoveryItem) => {
    setSelectedRuntime(runtime);
    if (runtime.runtimeKind === "codex" && permissionMode === "confirm") {
      setPermissionMode("readonly");
    }
  };

  const reset = () => {
    setStep("scan");
    setRuntimes([]);
    setSelectedRuntime(null);
    setWorkingDirectory("");
    setPermissionMode("execute");
    setResult(null);
    setError(null);
    setIsScanning(false);
    setIsChecking(false);
    setIsSelectingDirectory(false);
    setShowManualDirectoryInput(false);
    setManualDirectoryDraft("");
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const scanRuntimes = useCallback(async () => {
    setIsScanning(true);
    setError(null);
    setResult(null);
    try {
      const discovery = await discoverRuntimeEnvs();
      setRuntimes(discovery.items);
      setWorkingDirectory(discovery.workingDirectory);
      const firstInstalled = discovery.items.find((item) => item.installed) ?? null;
      setSelectedRuntime(firstInstalled);
      setStep(firstInstalled ? "select" : "scan");
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : "Runtime 扫描失败");
    } finally {
      setIsScanning(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void scanRuntimes();
  }, [open, scanRuntimes]);

  if (!open) return null;

  const runCheck = async () => {
    if (!selectedRuntime?.cliPath) return;
    setIsChecking(true);
    setError(null);
    setResult(null);
    try {
      const checked = await checkRuntimeEnv({
        name: selectedRuntime.label,
        runtimeKind: selectedRuntime.runtimeKind,
        workingDirectory: workingDirectory.trim(),
        cliPath: selectedRuntime.cliPath,
        permissionMode,
        filePolicy: DEFAULT_RUNTIME_FILE_POLICY,
      });
      setResult(checked);
      setStep("confirm");
    } catch (checkError) {
      setError(checkError instanceof Error ? checkError.message : "环境检测失败");
    } finally {
      setIsChecking(false);
    }
  };

  const applyWorkingDirectory = async (nextWorkingDirectory: string) => {
    if (!selectedRuntime?.cliPath) return;
    setWorkingDirectory(nextWorkingDirectory);
    setResult(null);
    const checked = await checkRuntimeEnv({
      name: selectedRuntime.label,
      runtimeKind: selectedRuntime.runtimeKind,
      workingDirectory: nextWorkingDirectory,
      cliPath: selectedRuntime.cliPath,
      permissionMode,
      filePolicy: DEFAULT_RUNTIME_FILE_POLICY,
    });
    setResult(checked);
  };

  const changeWorkingDirectory = async () => {
    if (!selectedRuntime?.cliPath) return;
    setIsSelectingDirectory(true);
    setError(null);
    setShowManualDirectoryInput(false);

    try {
      const selection = await selectRuntimeWorkingDirectory();
      if (selection.kind === "canceled") return;
      if (selection.kind === "manual") {
        setManualDirectoryDraft(workingDirectory);
        setShowManualDirectoryInput(true);
        setError(selection.reason);
        return;
      }
      await applyWorkingDirectory(selection.path);
    } catch (selectError) {
      setResult(null);
      setError(selectError instanceof Error ? selectError.message : "工作目录修改失败");
    } finally {
      setIsSelectingDirectory(false);
    }
  };

  const submitManualWorkingDirectory = async () => {
    const nextWorkingDirectory = manualDirectoryDraft.trim();
    if (!nextWorkingDirectory || !selectedRuntime?.cliPath) return;
    setIsSelectingDirectory(true);
    setError(null);
    try {
      await applyWorkingDirectory(nextWorkingDirectory);
      setShowManualDirectoryInput(false);
    } catch (selectError) {
      setResult(null);
      setError(selectError instanceof Error ? selectError.message : "工作目录修改失败");
    } finally {
      setIsSelectingDirectory(false);
    }
  };

  const canContinueSelect = Boolean(selectedRuntime?.installed);
  const canCheck = Boolean(selectedRuntime?.cliPath && workingDirectory.trim()) && !isChecking;
  const canSave = Boolean(result?.ok) && !isSelectingDirectory;

  return (
    <div className="fixed inset-0 z-[70] flex items-stretch justify-center bg-black/25 md:items-center" onClick={handleClose}>
      <div
        className="flex h-dvh w-full flex-col overflow-hidden border border-line bg-white md:h-auto md:max-h-[78vh] md:w-[720px] md:max-w-[92vw] md:rounded-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex h-14 flex-none items-center justify-between border-b border-line px-5">
          <div>
            <div className="text-[15px] font-medium text-[#111]">添加本地运行环境</div>
            <div className="mt-0.5 text-[12px] text-ink-soft">
              通过已连接的本机电脑扫描 CLI，选择后绑定为执行环境。请保持本机 daemon 在线。
            </div>
          </div>
          <button
            type="button"
            onClick={handleClose}
            aria-label="关闭本地环境引导"
            className="flex h-7 w-7 items-center justify-center rounded-md text-ink-faint hover:bg-surface hover:text-[#111]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-none border-b border-line px-4 py-3 md:px-5 md:py-4">
          <div className="flex gap-2 overflow-x-auto md:grid md:grid-cols-4">
            {steps.map((item, index) => {
              const active = item.key === step;
              const done = steps.findIndex((entry) => entry.key === step) > index;
              return (
                <div
                  key={item.key}
                    className={cn(
                      "min-w-[132px] md:min-w-0",
                    "rounded-xl border px-3 py-2 text-[12px]",
                    active && "border-[#111] bg-white text-[#111]",
                    done && "border-success-border bg-success-bg text-success",
                    !active && !done && "border-line bg-surface-subtle text-ink-soft",
                  )}
                >
                  <div className="font-medium">Step {index + 1}</div>
                  <div className="mt-0.5 whitespace-nowrap">{item.label}</div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          {error ? (
            <div className="mb-4 rounded-2xl border border-danger-border bg-danger-bg px-4 py-3 text-[12px] leading-5 text-danger-hover">
              {error}
            </div>
          ) : null}

          {step === "scan" ? (
            <ScanStep
              isScanning={isScanning}
              runtimes={runtimes}
              onScan={scanRuntimes}
            />
          ) : null}

          {step === "select" ? (
            <SelectRuntimeStep
              runtimes={runtimes}
              selectedRuntime={selectedRuntime}
              onSelect={selectRuntime}
            />
          ) : null}

          {step === "permission" ? (
            <PermissionStep
              runtimeKind={selectedRuntime?.runtimeKind}
              permissionMode={permissionMode}
              onChange={setPermissionMode}
            />
          ) : null}

          {step === "confirm" && selectedRuntime ? (
            <ConfirmStep
              runtime={selectedRuntime}
              permissionMode={permissionMode}
              workingDirectory={workingDirectory}
              result={result}
              isSelectingDirectory={isSelectingDirectory}
              showManualDirectoryInput={showManualDirectoryInput}
              manualDirectoryDraft={manualDirectoryDraft}
              onManualDirectoryDraftChange={setManualDirectoryDraft}
              onSubmitManualWorkingDirectory={submitManualWorkingDirectory}
              onChangeWorkingDirectory={changeWorkingDirectory}
            />
          ) : null}
        </div>

        <div className="flex h-14 flex-none items-center justify-between border-t border-line px-5">
          <button
            type="button"
            onClick={handleClose}
            className="inline-flex h-9 items-center rounded-lg border border-line bg-white px-3 text-[13px] text-ink-soft hover:bg-surface-hover"
          >
            取消
          </button>
          <div className="flex items-center gap-2">
            {step !== "scan" ? (
              <button
                type="button"
                onClick={() => {
                  if (step === "select") setStep("scan");
                  if (step === "permission") setStep("select");
                  if (step === "confirm") setStep("permission");
                }}
                className="inline-flex h-9 items-center rounded-lg border border-line bg-white px-3 text-[13px] text-ink-soft hover:bg-surface-hover"
              >
                上一步
              </button>
            ) : null}
            {step === "scan" ? (
              <button
                type="button"
                onClick={installedRuntimes.length > 0 ? () => setStep("select") : scanRuntimes}
                disabled={isScanning}
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-[#111] px-3 text-[13px] text-white hover:bg-[#222] disabled:cursor-not-allowed disabled:bg-line"
              >
                {isScanning ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {installedRuntimes.length > 0 ? "下一步" : "重新检测"}
              </button>
            ) : null}
            {step === "select" ? (
              <button
                type="button"
                onClick={() => setStep("permission")}
                disabled={!canContinueSelect}
                className="inline-flex h-9 items-center rounded-lg bg-[#111] px-3 text-[13px] text-white hover:bg-[#222] disabled:cursor-not-allowed disabled:bg-line"
              >
                下一步
              </button>
            ) : null}
            {step === "permission" ? (
              <button
                type="button"
                onClick={runCheck}
                disabled={!canCheck}
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-[#111] px-3 text-[13px] text-white hover:bg-[#222] disabled:cursor-not-allowed disabled:bg-line"
              >
                {isChecking ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                检测并确认
              </button>
            ) : null}
            {step === "confirm" ? (
              <button
                type="button"
                disabled={!canSave || !selectedRuntime}
                onClick={() => {
                  if (!result?.ok || !selectedRuntime) return;
                  onSave({
                    type: "local",
                    runtimeKind: selectedRuntime.runtimeKind,
                    name: selectedRuntime.label,
                    workingDirectory: workingDirectory.trim(),
                    cliPath: result.cliPath,
                    permissionMode,
                    filePolicy: DEFAULT_RUNTIME_FILE_POLICY,
                    health: {
                      status: "online",
                      cliPath: result.cliPath,
                      claudeVersion: result.version,
                    },
                    lastCheckedAt: new Date().toISOString(),
                    isDefault: true,
                  });
                  handleClose();
                }}
                className="inline-flex h-9 items-center rounded-lg bg-[#111] px-3 text-[13px] text-white hover:bg-[#222] disabled:cursor-not-allowed disabled:bg-line"
              >
                确认添加
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function ScanStep({
  isScanning,
  runtimes,
  onScan,
}: {
  isScanning: boolean;
  runtimes: RuntimeDiscoveryItem[];
  onScan: () => void;
}) {
  const hasResult = runtimes.length > 0;
  const installed = runtimes.filter((item) => item.installed);

  if (isScanning && !hasResult) {
    return (
      <div className="flex min-h-[260px] flex-col items-center justify-center text-center">
        <Loader2 className="h-6 w-6 animate-spin text-[#111]" />
        <div className="mt-4 text-[14px] font-medium text-[#111]">正在检测本地 Runtimes</div>
        <div className="mt-1 text-[12px] text-ink-soft">正在通过已连接电脑扫描 Claude / Codex / Gemini CLI…</div>
      </div>
    );
  }

  if (hasResult && installed.length === 0) {
    return (
      <div className="space-y-4">
        <div>
          <div className="text-[14px] font-medium text-[#111]">未检测到可用 Runtime</div>
          <div className="mt-1 text-[12px] leading-5 text-ink-soft">
            需要先安装至少一个 CLI，并确保命令在 PATH 中可用。安装后点击“重新检测”。
          </div>
        </div>
        <div className="grid gap-3">
          {runtimes.map((runtime) => (
            <RuntimeInstallCard key={runtime.runtimeKind} runtime={runtime} />
          ))}
        </div>
        <button
          type="button"
          onClick={onScan}
          className="inline-flex h-9 items-center rounded-lg border border-line bg-white px-3 text-[13px] text-[#111] hover:bg-surface-hover"
        >
          重新检测
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="text-[14px] font-medium text-[#111]">已完成本地 Runtime 检测</div>
      <div className="mt-1 text-[12px] leading-5 text-ink-soft">
        检测到 {installed.length} 个可用 Runtime。下一步选择要添加的 Runtime。
      </div>
      <div className="mt-4 grid gap-3">
        {runtimes.map((runtime) => (
          <RuntimeInstallCard key={runtime.runtimeKind} runtime={runtime} />
        ))}
      </div>
    </div>
  );
}

function SelectRuntimeStep({
  runtimes,
  selectedRuntime,
  onSelect,
}: {
  runtimes: RuntimeDiscoveryItem[];
  selectedRuntime: RuntimeDiscoveryItem | null;
  onSelect: (runtime: RuntimeDiscoveryItem) => void;
}) {
  return (
    <div>
      <div className="text-[14px] font-medium text-[#111]">选择要添加的 Runtime</div>
      <div className="mt-1 text-[12px] leading-5 text-ink-soft">
        这里只展示已安装并可执行的 Runtime。当前聊天链路支持 Claude CLI、Pi CLI、Cursor CLI 与 Codex CLI。
      </div>
      <div className="mt-4 grid gap-3">
        {runtimes.filter((runtime) => runtime.installed).map((runtime) => (
          <RuntimeSelectCard
            key={runtime.runtimeKind}
            runtime={runtime}
            selected={selectedRuntime?.runtimeKind === runtime.runtimeKind}
            onClick={() => onSelect(runtime)}
          />
        ))}
      </div>
    </div>
  );
}

function PermissionStep({
  runtimeKind,
  permissionMode,
  onChange,
}: {
  runtimeKind?: LocalRuntimeKind;
  permissionMode: RuntimePermissionMode;
  onChange: (mode: RuntimePermissionMode) => void;
}) {
  const isCodex = runtimeKind === "codex";
  return (
    <div>
      <div className="text-[14px] font-medium text-[#111]">确认权限模式</div>
      <div className="mt-1 text-[12px] leading-5 text-ink-soft">
        {isCodex
          ? "Codex exec 首版不支持 KiKi 手动确认，请选择只读聊天或项目内可执行。"
          : "默认推荐“手动确认”。后续也可以在运行环境列表里随时切换。"}
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-3">
        {permissionOptions.map((option) => {
          const disabled = isCodex && option.value === "confirm";
          const description = disabled
            ? "Codex exec 首版暂不支持 KiKi 手动确认"
            : option.description;
          return (
          <button
            key={option.value}
            type="button"
            onClick={() => {
              if (!disabled) onChange(option.value);
            }}
            disabled={disabled}
            className={cn(
              "rounded-2xl border px-4 py-3 text-left transition",
              disabled && "cursor-not-allowed opacity-50",
              option.value === permissionMode
                ? "border-[#111] bg-white"
                : "border-line bg-surface-subtle hover:bg-white",
            )}
          >
            <div className="text-[13px] font-medium text-[#111]">{option.label}</div>
            <div className="mt-1 text-[12px] leading-5 text-ink-soft">{description}</div>
          </button>
          );
        })}
      </div>
    </div>
  );
}

function ConfirmStep({
  runtime,
  permissionMode,
  workingDirectory,
  result,
  isSelectingDirectory,
  showManualDirectoryInput,
  manualDirectoryDraft,
  onManualDirectoryDraftChange,
  onSubmitManualWorkingDirectory,
  onChangeWorkingDirectory,
}: {
  runtime: RuntimeDiscoveryItem;
  permissionMode: RuntimePermissionMode;
  workingDirectory: string;
  result: RuntimeEnvironmentCheckResult | null;
  isSelectingDirectory: boolean;
  showManualDirectoryInput: boolean;
  manualDirectoryDraft: string;
  onManualDirectoryDraftChange: (value: string) => void;
  onSubmitManualWorkingDirectory: () => void;
  onChangeWorkingDirectory: () => void;
}) {
  return (
    <div>
      <div className="text-[14px] font-medium text-[#111]">确认运行环境信息</div>
      <div className="mt-1 text-[12px] leading-5 text-ink-soft">
        保存后会把这个 Runtime 设为当前默认环境，KiKi 助手和会话页都会优先使用它。
      </div>
      <div className="mt-4 grid gap-3">
        <InfoBlock label="Runtime" value={runtime.label} />
        <InfoBlock label="CLI 路径" value={result?.cliPath || runtime.cliPath || runtime.command} />
        <InfoBlock label="版本信息" value={result?.version || runtime.version || "未知"} />
        <InfoBlock
          label="权限模式"
          value={permissionOptions.find((item) => item.value === permissionMode)?.label || permissionMode}
        />
        <div className="rounded-2xl border border-line bg-white px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="text-[12px] text-ink-soft">工作目录</div>
            <button
              type="button"
              onClick={onChangeWorkingDirectory}
              disabled={isSelectingDirectory}
              className={cn(
                "inline-flex h-8 items-center gap-2 rounded-lg border border-line bg-white px-3 text-[12px] text-[#111] hover:bg-surface-hover",
                isSelectingDirectory && "cursor-not-allowed bg-surface-subtle text-ink-faint",
              )}
            >
              {isSelectingDirectory ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderOpen className="h-4 w-4" />}
              修改
            </button>
          </div>
          <div className="mt-1 break-all text-[13px] text-[#111]">{workingDirectory}</div>
          <div className="mt-1 text-[12px] leading-5 text-ink-soft">修改后会自动重新检测该目录是否可用。</div>
          {showManualDirectoryInput ? (
            <div className="mt-3 space-y-2 rounded-xl border border-warning-border bg-warning-bg px-3 py-3">
              <div className="text-[12px] leading-5 text-warning-strong">
                云端无法直接打开目录选择器，请输入你本机上的绝对路径（例如 /Users/你的名字/Projects）。
              </div>
              <input
                type="text"
                value={manualDirectoryDraft}
                onChange={(event) => onManualDirectoryDraftChange(event.target.value)}
                placeholder="/Users/you/Projects"
                className="w-full rounded-lg border border-line bg-white px-3 py-2 text-[13px] text-[#111] outline-none focus:border-[#111]"
              />
              <button
                type="button"
                onClick={onSubmitManualWorkingDirectory}
                disabled={!manualDirectoryDraft.trim() || isSelectingDirectory}
                className="inline-flex h-8 items-center rounded-lg bg-[#111] px-3 text-[12px] text-white hover:bg-[#222] disabled:cursor-not-allowed disabled:bg-line"
              >
                确认路径并检测
              </button>
            </div>
          ) : null}
        </div>
      </div>
      {result?.ok ? (
        <div className="mt-4 rounded-2xl border border-success-border bg-success-bg px-4 py-3 text-[12px] text-success">
          <div className="flex items-center gap-2 font-medium">
            <CheckCircle2 className="h-4 w-4" />
            <span>Runtime 检测通过，可以添加</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function RuntimeInstallCard({ runtime }: { runtime: RuntimeDiscoveryItem }) {
  const meta = getRuntimeMeta(runtime);
  return (
    <div className="rounded-2xl border border-line bg-white px-4 py-3">
      <div className="flex items-start gap-3">
        <span className={cn("flex h-9 w-9 items-center justify-center rounded-xl", meta.accent)}>
          {meta.icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="text-[14px] font-medium text-[#111]">{runtime.label}</div>
            <span
              className={cn(
                "rounded-full border px-2 py-1 text-[11px]",
                runtime.installed
                  ? "border-success-border bg-success-bg text-success"
                  : "border-line bg-surface-subtle text-ink-soft",
              )}
            >
              {runtime.installed ? "已安装" : "未安装"}
            </span>
          </div>
          <div className="mt-1 break-all text-[12px] leading-5 text-ink-soft">
            {runtime.installed
              ? `${runtime.cliPath || runtime.command}${runtime.version ? ` · ${runtime.version}` : ""}`
              : runtime.installHint}
          </div>
        </div>
      </div>
    </div>
  );
}

function RuntimeSelectCard({
  runtime,
  selected,
  onClick,
}: {
  runtime: RuntimeDiscoveryItem;
  selected: boolean;
  onClick: () => void;
}) {
  const meta = getRuntimeMeta(runtime);
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-2xl border bg-white px-4 py-3 text-left transition",
        selected ? "border-[#111]" : "border-line hover:border-[#111]",
      )}
    >
      <div className="flex items-start gap-3">
        <span className={cn("flex h-9 w-9 items-center justify-center rounded-xl", meta.accent)}>
          {meta.icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <div className="text-[14px] font-medium text-[#111]">{runtime.label}</div>
            {selected ? (
              <span className="rounded-full border border-[#111] px-2 py-1 text-[11px] text-[#111]">
                已选择
              </span>
            ) : null}
          </div>
          <div className="mt-1 break-all text-[12px] leading-5 text-ink-soft">
            {runtime.cliPath || runtime.command}
            {runtime.version ? ` · ${runtime.version}` : ""}
          </div>
        </div>
      </div>
    </button>
  );
}

function InfoBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-line bg-white px-4 py-3">
      <div className="text-[12px] text-ink-soft">{label}</div>
      <div className="mt-1 break-all text-[13px] text-[#111]">{value}</div>
    </div>
  );
}

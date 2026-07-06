"use client";

import { CheckCircle2, Copy, Loader2, Terminal, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { createMachine, listMachines, type MachineRecord } from "@/lib/api/machines";
import { cn } from "@/lib/utils";

const PENDING_CONNECT_KEY = "kiki-connect-machine-pending";

type PendingConnect = {
  machineId: string;
  apiKey: string;
  connectCommand: string;
};

function readPendingConnect(): PendingConnect | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(PENDING_CONNECT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingConnect;
    if (!parsed.machineId || !parsed.apiKey || !parsed.connectCommand) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writePendingConnect(pending: PendingConnect) {
  window.sessionStorage.setItem(PENDING_CONNECT_KEY, JSON.stringify(pending));
}

function clearPendingConnect() {
  window.sessionStorage.removeItem(PENDING_CONNECT_KEY);
}

function formatRelativeTime(value?: string | null) {
  if (!value) return "暂无";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 60_000) return "刚刚";
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)} 分钟前`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)} 小时前`;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function formatMachineFingerprint(fingerprint?: string | null) {
  if (!fingerprint) return "未知平台";
  const matched = /^device:([^:]+):(.+)$/.exec(fingerprint);
  if (!matched) return fingerprint;
  return `${matched[1]} · ${matched[2].slice(0, 8)}`;
}

type Props = {
  open: boolean;
  onClose: () => void;
  onConnected?: (machine: MachineRecord) => void;
};

export function ConnectMachineDialog({ open, onClose, onConnected }: Props) {
  const [connectCommand, setConnectCommand] = useState("");
  const [pendingMachineId, setPendingMachineId] = useState<string | null>(null);
  const [connectedMachine, setConnectedMachine] = useState<MachineRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const onConnectedRef = useRef(onConnected);

  useEffect(() => {
    onConnectedRef.current = onConnected;
  }, [onConnected]);

  const reset = useCallback(() => {
    setConnectCommand("");
    setPendingMachineId(null);
    setConnectedMachine(null);
    setLoading(false);
    setError(null);
    setCopied(false);
  }, []);

  const handleClose = useCallback(() => {
    reset();
    onClose();
  }, [onClose, reset]);

  const startConnection = useCallback(async () => {
    setLoading(true);
    setError(null);
    setCopied(false);
    try {
      const cached = readPendingConnect();
      if (cached) {
        const listed = await listMachines();
        const stillPending = listed.machines.find(
          (machine) => machine.id === cached.machineId && !machine.lastSeenAt,
        );
        if (stillPending) {
          setConnectCommand(cached.connectCommand);
          setPendingMachineId(cached.machineId);
          setConnectedMachine(null);
          return;
        }
        clearPendingConnect();
      }

      const result = await createMachine();
      writePendingConnect({
        machineId: result.machine.id,
        apiKey: result.apiKey,
        connectCommand: result.connectCommand,
      });
      setConnectCommand(result.connectCommand);
      setPendingMachineId(result.machine.id);
      setConnectedMachine(null);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : "创建连接失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void startConnection();
  }, [open, startConnection]);

  useEffect(() => {
    if (!open || !pendingMachineId || connectedMachine) return;

    let cancelled = false;
    const poll = async () => {
      try {
        const result = await listMachines();
        if (cancelled) return;
        const matched = result.machines.find((machine) => machine.id === pendingMachineId && machine.online);
        if (matched) {
          clearPendingConnect();
          setConnectedMachine(matched);
          onConnectedRef.current?.(matched);
        }
      } catch {
        // 轮询失败不打断等待态
      }
    };

    void poll();
    const timer = window.setInterval(() => {
      void poll();
    }, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [open, pendingMachineId, connectedMachine]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") handleClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, handleClose]);

  const copyCommand = async () => {
    if (!connectCommand) return;
    try {
      await navigator.clipboard.writeText(connectCommand);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("复制失败，请手动选择命令复制");
    }
  };

  if (!open) return null;

  const isConnected = Boolean(connectedMachine);

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/25 px-4" onClick={handleClose}>
      <div
        className="flex w-[560px] max-w-[92vw] flex-col overflow-hidden rounded-2xl border border-line bg-white shadow-[0_12px_40px_rgba(16,24,40,0.12)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex flex-none items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <div className="text-[15px] font-medium text-[#111]">连接本机电脑</div>
            <div className="mt-0.5 text-[12px] leading-5 text-ink-soft">
              在本机终端运行下方命令，注册为执行节点。安装后 daemon 后台常驻，可关闭终端。
            </div>
          </div>
          <button
            type="button"
            onClick={handleClose}
            aria-label="关闭"
            className="flex h-7 w-7 flex-none items-center justify-center rounded-md text-ink-faint hover:bg-surface hover:text-[#111]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-col gap-4 px-5 py-5">
          {error ? (
            <div className="rounded-xl border border-danger-border bg-danger-bg px-4 py-3 text-[12px] leading-5 text-danger-hover">
              {error}
            </div>
          ) : null}

          <div>
            <div className="mb-1.5 flex items-center gap-1.5 text-[12px] text-ink-strong">
              <Terminal className="h-3.5 w-3.5" />
              <span>在本机终端运行此命令：</span>
            </div>
            <div className="relative rounded-xl border border-ink bg-[#111] px-4 py-3">
              {loading ? (
                <div className="flex items-center gap-2 py-2 text-[12px] text-ink-faint">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  正在生成连接命令…
                </div>
              ) : (
                <code className="block whitespace-pre-wrap break-all pr-9 font-mono text-[12.5px] leading-6 text-success-border">
                  {connectCommand || "—"}
                </code>
              )}
              <button
                type="button"
                onClick={() => void copyCommand()}
                disabled={!connectCommand || loading}
                aria-label="复制命令"
                className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-md text-ink-faint hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Copy className="h-4 w-4" />
              </button>
            </div>
            {copied ? <div className="mt-1.5 text-[11px] text-success">已复制到剪贴板</div> : null}
            <div className="mt-1.5 text-[11px] text-ink-faint">api-key 仅展示一次，请妥善保存。</div>
          </div>

          {!isConnected ? (
            <div className="flex items-center gap-3 rounded-xl border border-warning-border bg-warning-bg px-4 py-3">
              <span className="h-2.5 w-2.5 flex-none animate-pulse rounded-full bg-warning" />
              <div className="text-[13px] font-medium text-warning-strong">等待电脑连接…</div>
            </div>
          ) : (
            <div className="flex items-center gap-3 rounded-xl border border-success-border bg-success-bg px-4 py-3">
              <CheckCircle2 className="h-4 w-4 flex-none text-success" />
              <div className="flex-1">
                <div className="text-[13px] font-medium text-success">
                  已连接：{connectedMachine?.name || "本机电脑"}
                </div>
                <div className="mt-0.5 text-[12px] text-success">
                  {formatMachineFingerprint(connectedMachine?.fingerprint)} · {formatRelativeTime(connectedMachine?.lastSeenAt)} · 在线
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-none items-center justify-end gap-2 border-t border-line px-5 py-4">
          <button
            type="button"
            onClick={handleClose}
            className="inline-flex h-9 items-center rounded-lg border border-line bg-white px-3 text-[13px] text-ink-soft hover:bg-surface-hover"
          >
            取消
          </button>
          <button
            type="button"
            disabled={!isConnected}
            onClick={handleClose}
            className={cn(
              "inline-flex h-9 items-center rounded-lg bg-[#111] px-3 text-[13px] text-white hover:bg-[#222]",
              !isConnected && "cursor-not-allowed bg-line hover:bg-line",
            )}
          >
            完成
          </button>
        </div>
      </div>
    </div>
  );
}

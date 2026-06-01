"use client";

import { useState } from "react";

import { formatRoleDisplay } from "@/lib/devPanel/formatRoleDisplay";
import {
  useAgentEventsByRun,
  useAgentRunsBySaga,
  useSagaInstances,
} from "@/lib/devPanel/hooks";
import { useAgentRunsStore } from "@/stores/agentRunsStore";
import type { AgentEvent, AgentRun, SagaInstance } from "@/types/agentRuntime";

/**
 * DevPanel /dev/runtime — Topic/Thread 运行流可视化（PR15 §12.5.1）。
 *
 * 三栏布局：
 *  - 左：SagaInstancesList（按 status 分组）
 *  - 右上：SagaRunsTimeline（选中 saga 的 agent_runs 时间线，按 scope 三组）
 *  - 右下：CausationTree（agent_events 按 sequence）
 */

type Selection = { sagaId: string | null; runId: string | null };

export default function DevRuntimePage() {
  const [selection, setSelection] = useState<Selection>({ sagaId: null, runId: null });

  return (
    <div className="flex h-screen w-full bg-[#F8F9FB] text-[#111]">
      <aside className="w-[320px] border-r border-[#E5E7EB] overflow-y-auto">
        <SagaInstancesList
          selectedSagaId={selection.sagaId}
          onSelect={(sagaId) => setSelection({ sagaId, runId: null })}
        />
      </aside>
      <main className="flex flex-1 flex-col overflow-hidden">
        <section className="border-b border-[#E5E7EB] flex-1 overflow-y-auto p-4">
          <SagaRunsTimeline
            sagaId={selection.sagaId}
            selectedRunId={selection.runId}
            onSelectRun={(runId) => setSelection((s) => ({ ...s, runId }))}
          />
        </section>
        <section className="flex-1 overflow-y-auto p-4">
          <CausationTree runId={selection.runId} />
        </section>
      </main>
    </div>
  );
}

// ───────────────────────────── SagaInstancesList ─────────────────────────────

function SagaInstancesList({
  selectedSagaId,
  onSelect,
}: {
  selectedSagaId: string | null;
  onSelect: (sagaId: string) => void;
}) {
  const { items, total, loading, error, refetch } = useSagaInstances({ limit: 50 });

  return (
    <div className="p-3">
      <header className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Saga 实例（{total}）</h2>
        <button
          type="button"
          className="text-xs text-[#3B82F6] hover:underline"
          onClick={refetch}
        >
          刷新
        </button>
      </header>
      {loading ? <p className="text-xs text-[#6B7280]">加载中…</p> : null}
      {error ? <p className="text-xs text-[#DC2626]">{error}</p> : null}
      <ul className="space-y-1">
        {items.map((saga) => (
          <li key={saga.id}>
            <button
              type="button"
              onClick={() => onSelect(saga.id)}
              className={`w-full rounded-md border px-2 py-2 text-left text-xs ${
                saga.id === selectedSagaId
                  ? "border-[#3B82F6] bg-[#EFF6FF]"
                  : "border-[#E5E7EB] bg-white hover:bg-[#F3F4F6]"
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="font-medium">{saga.type}</span>
                <SagaStatusBadge status={saga.status} />
              </div>
              <div className="mt-0.5 truncate text-[10px] text-[#6B7280]">
                {saga.id}
              </div>
              {saga.currentStep ? (
                <div className="mt-0.5 text-[10px] text-[#374151]">step: {saga.currentStep}</div>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
      {!loading && items.length === 0 ? (
        <p className="text-xs text-[#6B7280]">无 saga 实例</p>
      ) : null}
    </div>
  );
}

function SagaStatusBadge({ status }: { status: SagaInstance["status"] }) {
  const map: Record<SagaInstance["status"], string> = {
    pending: "bg-[#E5E7EB] text-[#374151]",
    running: "bg-[#DBEAFE] text-[#1D4ED8]",
    awaiting_user: "bg-[#FEF3C7] text-[#92400E]",
    completed: "bg-[#DCFCE7] text-[#166534]",
    failed: "bg-[#FEE2E2] text-[#991B1B]",
  };
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] ${map[status]}`}>
      {status}
    </span>
  );
}

// ───────────────────────────── SagaRunsTimeline ─────────────────────────────

function SagaRunsTimeline({
  sagaId,
  selectedRunId,
  onSelectRun,
}: {
  sagaId: string | null;
  selectedRunId: string | null;
  onSelectRun: (runId: string) => void;
}) {
  const { saga, runs, loading, error, refetch } = useAgentRunsBySaga(sagaId);

  if (!sagaId) {
    return <p className="text-xs text-[#6B7280]">从左侧选择一个 saga 查看 agent_runs 时间线。</p>;
  }

  // 按 scope 三组（§12.5.3）
  const grouped: Record<"topic_saga" | "thread" | "task_orchestration", AgentRun[]> = {
    topic_saga: [],
    thread: [],
    task_orchestration: [],
  };
  for (const run of runs) {
    grouped[formatRoleDisplay(run.role).scope].push(run);
  }

  return (
    <div>
      <header className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold">
          {saga ? `${saga.type} · ${saga.status}` : "saga 时间线"}
        </h2>
        <button
          type="button"
          className="text-xs text-[#3B82F6] hover:underline"
          onClick={refetch}
        >
          刷新
        </button>
      </header>
      {loading ? <p className="text-xs text-[#6B7280]">加载中…</p> : null}
      {error ? <p className="text-xs text-[#DC2626]">{error}</p> : null}
      <div className="grid grid-cols-3 gap-3">
        <RunGroup
          title="topic_saga"
          runs={grouped.topic_saga}
          selectedRunId={selectedRunId}
          onSelectRun={onSelectRun}
          onCommandApplied={refetch}
        />
        <RunGroup
          title="thread"
          runs={grouped.thread}
          selectedRunId={selectedRunId}
          onSelectRun={onSelectRun}
          onCommandApplied={refetch}
        />
        <RunGroup
          title="task_orchestration"
          runs={grouped.task_orchestration}
          selectedRunId={selectedRunId}
          onSelectRun={onSelectRun}
          onCommandApplied={refetch}
        />
      </div>
    </div>
  );
}

function RunGroup({
  title,
  runs,
  selectedRunId,
  onSelectRun,
  onCommandApplied,
}: {
  title: string;
  runs: AgentRun[];
  selectedRunId: string | null;
  onSelectRun: (runId: string) => void;
  onCommandApplied: () => void;
}) {
  return (
    <div className="rounded-md border border-[#E5E7EB] bg-white p-2">
      <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[#6B7280]">
        {title}
      </h3>
      {runs.length === 0 ? (
        <p className="text-[11px] text-[#9CA3AF]">—</p>
      ) : (
        <ul className="space-y-1">
          {runs.map((run) => (
            <li
              key={run.id}
              className={`rounded border ${
                run.id === selectedRunId
                  ? "border-[#3B82F6] bg-[#EFF6FF]"
                  : "border-transparent bg-[#F9FAFB]"
              }`}
            >
              <button
                type="button"
                onClick={() => onSelectRun(run.id)}
                className="w-full rounded px-2 py-1 text-left text-[11px] hover:bg-[#F3F4F6]"
              >
                <div className="flex items-center justify-between">
                  <span>{run.role}</span>
                  <span className="text-[10px] text-[#6B7280]">{run.status}</span>
                </div>
                <div className="truncate text-[10px] text-[#9CA3AF]">{run.id}</div>
              </button>
              <RunCommandButtons run={run} onCommandApplied={onCommandApplied} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type AgentRunCommandKind = "pause" | "resume" | "cancel" | "retry";

const COMMAND_LABEL: Record<AgentRunCommandKind, string> = {
  pause: "Pause",
  resume: "Resume",
  cancel: "Cancel",
  retry: "Retry",
};

function allowedCommands(run: AgentRun): AgentRunCommandKind[] {
  switch (run.status) {
    case "pending":
    case "running":
      return ["pause", "cancel"];
    case "paused":
      return ["resume", "cancel"];
    case "failed":
      return ["retry"];
    default:
      return [];
  }
}

function RunCommandButtons({
  run,
  onCommandApplied,
}: {
  run: AgentRun;
  onCommandApplied: () => void;
}) {
  const upsertRun = useAgentRunsStore((state) => state.upsertRun);
  const [pending, setPending] = useState<AgentRunCommandKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const commands = allowedCommands(run);

  if (commands.length === 0) return null;

  const execute = async (kind: AgentRunCommandKind) => {
    setPending(kind);
    setError(null);
    try {
      const response = await fetch("/api/agents/runs/commands", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `dev-runtime-${run.id}-${kind}-${Date.now()}`,
        },
        body: JSON.stringify({
          command: { kind, agentRunId: run.id },
          baseRevision: run.revision,
        }),
      });
      const json = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        reason?: string;
        agentRun?: AgentRun;
      };
      if (!response.ok || json.ok !== true) {
        throw new Error(json.reason || `${kind} failed`);
      }
      if (json.agentRun) upsertRun(json.agentRun);
      onCommandApplied();
    } catch (err) {
      setError(err instanceof Error ? err.message : "command failed");
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="border-t border-[#E5E7EB] px-2 py-1">
      <div className="flex flex-wrap gap-1">
        {commands.map((kind) => (
          <button
            key={kind}
            type="button"
            disabled={pending !== null}
            onClick={() => void execute(kind)}
            className="rounded bg-white px-1.5 py-0.5 text-[10px] text-[#374151] ring-1 ring-[#D1D5DB] hover:bg-[#F3F4F6] disabled:opacity-50"
          >
            {pending === kind ? "..." : COMMAND_LABEL[kind]}
          </button>
        ))}
      </div>
      {error ? <p className="mt-1 text-[10px] text-[#DC2626]">{error}</p> : null}
    </div>
  );
}

// ───────────────────────────── CausationTree ─────────────────────────────

function CausationTree({ runId }: { runId: string | null }) {
  const { run, events, loading, error, refetch } = useAgentEventsByRun(runId);

  if (!runId) {
    return <p className="text-xs text-[#6B7280]">从上方选择一个 agent_run 查看因果链事件流。</p>;
  }

  return (
    <div>
      <header className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold">
          {run ? `${run.role} · ${run.status} · seq=${run.lastEventSeq}` : "因果链"}
        </h2>
        <button
          type="button"
          className="text-xs text-[#3B82F6] hover:underline"
          onClick={refetch}
        >
          刷新
        </button>
      </header>
      {loading ? <p className="text-xs text-[#6B7280]">加载中…</p> : null}
      {error ? <p className="text-xs text-[#DC2626]">{error}</p> : null}
      <ol className="space-y-1">
        {events.map((event) => (
          <EventRow key={event.id} event={event} />
        ))}
      </ol>
      {!loading && events.length === 0 ? (
        <p className="text-xs text-[#6B7280]">暂无事件</p>
      ) : null}
    </div>
  );
}

function EventRow({ event }: { event: AgentEvent }) {
  return (
    <li className="rounded border border-[#E5E7EB] bg-white p-2">
      <div className="flex items-center justify-between text-[11px]">
        <span className="font-medium">
          #{event.seq} · {event.type}
        </span>
        <span className="text-[10px] text-[#6B7280]">{event.createdAt}</span>
      </div>
      {event.payloadRef ? (
        <p className="mt-1 text-[10px] text-[#9CA3AF]">payloadRef: {event.payloadRef}</p>
      ) : null}
    </li>
  );
}

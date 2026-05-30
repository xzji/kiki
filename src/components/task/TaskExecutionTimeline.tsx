"use client";

import type { ReactNode } from "react";

import { formatToolOperationDisplay, formatToolOperationText, type ToolOperationDisplay } from "@/lib/execution/summarizeToolOperation";
import type { AgentRole, AgentRoleRun, AgentRunPlan } from "@/types/agentOrchestration";
import type { TaskExecutionStep } from "@/types/kiki";

const ROLE_LABEL: Record<AgentRole, string> = {
  coordinator: "Coordinator",
  researcher: "Researcher",
  executor: "Executor",
  reviewer: "Reviewer",
  synthesizer: "Presenter",
};

const ROLE_AVATAR: Record<AgentRole, string> = {
  coordinator: "C",
  researcher: "R",
  executor: "E",
  reviewer: "V",
  synthesizer: "P",
};

type TimelineGroup = {
  id: string;
  role?: AgentRole;
  steps: TaskExecutionStep[];
  run?: AgentRoleRun;
  attempt: number;
};

type ProcessStep = {
  id: string;
  thought: string;
  tool?: {
    name: string;
    detail: string;
    display: ToolOperationDisplay;
  };
};

type Verdict = {
  label: "通过" | "打回" | "失败" | "完成";
  tone: "ok" | "warn";
};

function formatStepTime(value: string | undefined) {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function isVisibleExecutionStep(step: TaskExecutionStep) {
  return (
    step.toolName !== "debug.stream_event" &&
    !step.title.trim().startsWith("[debug]") &&
    !step.detail?.trim().startsWith("[debug]") &&
    !step.handoff
  );
}

function isAssistantProcessStep(step: TaskExecutionStep) {
  return step.type === "assistant" && !step.toolName && step.title === "Agent 过程输出（非最终结果）";
}

function appendAssistantProcessText(previous: string, next: string) {
  if (!previous) return next;
  if (!next) return previous;
  return /[。！？.!?]\s*$/.test(previous) ? `${previous}\n${next}` : `${previous}${next}`;
}

function mergeAssistantProcessSteps(steps: TaskExecutionStep[]) {
  const merged: TaskExecutionStep[] = [];
  for (const step of steps) {
    const previous = merged.at(-1);
    if (previous && isAssistantProcessStep(previous) && isAssistantProcessStep(step)) {
      merged[merged.length - 1] = {
        ...previous,
        status: step.status,
        detail: appendAssistantProcessText(previous.detail?.trim() ?? "", step.detail?.trim() ?? ""),
        finishedAt: step.finishedAt ?? previous.finishedAt,
      };
      continue;
    }
    merged.push(step);
  }
  return merged;
}

function getStepText(step: TaskExecutionStep) {
  return (step.detail?.trim() || step.title.trim() || "继续执行当前步骤。").trim();
}

function getToolDetail(step: TaskExecutionStep) {
  return formatToolOperationText(step.title, step.detail?.trim());
}

function groupTimelineSteps(steps: TaskExecutionStep[]) {
  const groups: TimelineGroup[] = [];
  const roleAttempts = new Map<AgentRole | "single", number>();

  for (const step of steps) {
    const roleKey = step.agentRole ?? "single";
    const previous = groups.at(-1);
    if (previous && (previous.role ?? "single") === roleKey) {
      previous.steps.push(step);
      continue;
    }

    const nextAttempt = (roleAttempts.get(roleKey) ?? 0) + 1;
    roleAttempts.set(roleKey, nextAttempt);
    groups.push({
      id: `${roleKey}-${nextAttempt}-${step.id}`,
      role: step.agentRole,
      steps: [step],
      attempt: nextAttempt,
    });
  }

  return groups;
}

function attachRoleRuns(groups: TimelineGroup[], agentRunPlan: AgentRunPlan | undefined) {
  if (!agentRunPlan?.roles.length) return groups;
  const roleRunIndex = new Map<AgentRole, number>();
  return groups.map((group) => {
    if (!group.role) return group;
    const index = roleRunIndex.get(group.role) ?? 0;
    roleRunIndex.set(group.role, index + 1);
    const run = agentRunPlan.roles.filter((item) => item.role === group.role)[index];
    return run ? { ...group, run } : group;
  });
}

function groupsFromPlan(agentRunPlan: AgentRunPlan | undefined) {
  if (!agentRunPlan?.roles.length) return [];
  const roleAttempts = new Map<AgentRole, number>();
  return agentRunPlan.roles.map((run) => {
    const attempt = (roleAttempts.get(run.role) ?? 0) + 1;
    roleAttempts.set(run.role, attempt);
    return {
      id: run.id,
      role: run.role,
      run,
      attempt,
      steps: [
        {
          id: `${run.id}-objective`,
          title: run.title,
          type: "assistant" as const,
          status: run.status === "failed" ? "failed" as const : run.status === "running" ? "running" as const : "completed" as const,
          agentRole: run.role,
          detail: run.objective || run.inputSummary,
          startedAt: run.startedAt ?? new Date().toISOString(),
          finishedAt: run.finishedAt,
        },
      ],
    } satisfies TimelineGroup;
  });
}

function buildProcessSteps(steps: TaskExecutionStep[]) {
  const processSteps: ProcessStep[] = [];

  for (const step of steps) {
    if (step.toolName) {
      const tool = {
        name: step.toolName,
        detail: getToolDetail(step),
        display: formatToolOperationDisplay(step.toolName, step.title, step.detail?.trim(), step.toolInput),
      };
      const previous = processSteps.at(-1);
      if (previous && !previous.tool) {
        previous.tool = tool;
      } else {
        processSteps.push({
          id: step.id,
          thought: step.title.trim() || "调用工具补充执行上下文。",
          tool,
        });
      }
      continue;
    }

    processSteps.push({
      id: step.id,
      thought: getStepText(step),
    });
  }

  return processSteps;
}

function buildResponse(group: TimelineGroup) {
  if (group.run?.outputSummary?.trim()) return group.run.outputSummary.trim();
  if (group.run?.error?.trim()) return group.run.error.trim();
  const responseStep = [...group.steps].reverse().find((step) => !step.toolName && ["assistant", "result", "system"].includes(step.type));
  if (responseStep) return getStepText(responseStep);
  const fallback = group.steps.at(-1);
  return fallback ? getStepText(fallback) : "等待本轮输出。";
}

function buildVerdict(group: TimelineGroup, agentRunPlan: AgentRunPlan | undefined, isLastReviewer: boolean): Verdict | undefined {
  if (group.run?.status === "failed" || group.steps.some((step) => step.status === "failed")) {
    return { label: "失败", tone: "warn" };
  }
  if (group.role === "reviewer") {
    const response = buildResponse(group);
    if (/不通过|打回|blocking|缺失|失败|未通过/.test(response)) return { label: "打回", tone: "warn" };
    if (isLastReviewer && agentRunPlan?.review) {
      return agentRunPlan.review.passed ? { label: "通过", tone: "ok" } : { label: "打回", tone: "warn" };
    }
    return { label: "通过", tone: "ok" };
  }
  if (!group.role && group.steps.some((step) => step.type === "result" && step.status === "completed")) {
    return { label: "完成", tone: "ok" };
  }
  return undefined;
}

function getGroupName(group: TimelineGroup) {
  if (!group.role) return "KiKi";
  const base = ROLE_LABEL[group.role];
  return group.attempt > 1 ? `${base} · 第 ${group.attempt} 轮` : base;
}

function getGroupAvatar(group: TimelineGroup) {
  return group.role ? ROLE_AVATAR[group.role] : "K";
}

function getGroupTime(group: TimelineGroup) {
  return formatStepTime(group.run?.finishedAt ?? group.run?.startedAt ?? group.steps.at(-1)?.finishedAt ?? group.steps.at(-1)?.startedAt);
}

function isLastReviewerGroup(groups: TimelineGroup[], groupIndex: number) {
  return groups.findLastIndex((group) => group.role === "reviewer") === groupIndex;
}

function isResumeSubmissionStep(step: TaskExecutionStep) {
  return step.id.startsWith("resume-") || /^已提交|^已收到用户|^用户要求\s*KiKi/.test(step.title.trim());
}

function buildGroups(steps: TaskExecutionStep[], agentRunPlan: AgentRunPlan | undefined) {
  return attachRoleRuns(groupTimelineSteps(steps), agentRunPlan);
}

function ToolActionBadge({ tool }: { tool: NonNullable<ProcessStep["tool"]> }) {
  const paths = tool.display.paths ?? [];
  const hasPaths = paths.length > 0;
  // action 形如「执行命令：ls -la /Users/...」时，把短动词前缀和长参数拆开，
  // 让长参数走可换行通道，避免 shrink-0 + 长串导致溢出截断。
  const actionMatch = tool.display.action.match(/^([^：:]{1,12}[：:])\s*(.+)$/);
  const actionPrefix = actionMatch ? actionMatch[1] : tool.display.action;
  const actionBody = actionMatch ? actionMatch[2] : "";

  return (
    <div className="w-fit max-w-full rounded-2xl bg-[#EEF0F3] px-2.5 py-2 text-[12px] leading-5 text-[#374151]">
      <div className="flex max-w-full items-start gap-2">
        <span className="shrink-0 rounded-full bg-white px-2 py-0.5 font-mono font-bold text-[#1F2328]">
          {tool.name}
        </span>
        <span className="shrink-0 font-semibold text-[#1F2328]">{actionPrefix}</span>
        {actionBody ? (
          <span className="min-w-0 whitespace-pre-wrap break-all text-[#1F2328]">{actionBody}</span>
        ) : null}
        {tool.display.objectText ? (
          <span className="min-w-0 whitespace-pre-wrap break-all text-[#4B5563]">{tool.display.objectText}</span>
        ) : null}
      </div>
      {hasPaths ? (
        <details className="group/path mt-1.5 pl-[54px]">
          <summary className="cursor-pointer list-none text-[12px] text-[#6B7280] select-none marker:hidden hover:text-[#1F2328] [&::-webkit-details-marker]:hidden">
            <span className="group-open/path:hidden">展开路径详情</span>
            <span className="hidden group-open/path:inline">收起路径详情</span>
          </summary>
          <div className="mt-2 grid gap-1.5 rounded-xl bg-white px-3 py-2 text-[12px] leading-5 text-[#4B5563]">
            {paths.map((path, index) => (
              <div key={`${path}-${index}`} className="grid min-w-0 grid-cols-[48px_minmax(0,1fr)] gap-2">
                <span className="text-[#8C9198]">{paths.length > 1 ? `文件 ${index + 1}` : "文件"}</span>
                <span className="min-w-0 break-words">{path}</span>
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function AgentMessage({ group, verdict }: { group: TimelineGroup; verdict?: Verdict }) {
  const processSteps = buildProcessSteps(group.steps);
  const response = buildResponse(group);
  const time = getGroupTime(group);

  return (
    <article className="group relative grid grid-cols-[42px_minmax(0,1fr)] gap-3 md:grid-cols-[42px_minmax(0,1fr)]">
      <div className="grid h-[42px] w-[42px] place-items-center rounded-full border border-[#E5E7EB] bg-white text-[13px] font-bold text-[#64748B]">
        {getGroupAvatar(group)}
      </div>
      <div className="min-w-0 pt-0.5">
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-bold text-[#1F2328]">{getGroupName(group)}</span>
          {time ? <span className="text-[12px] text-[#8C9198] opacity-0 transition-opacity duration-150 group-hover:opacity-100">{time}</span> : null}
        </div>
        <div className="flex max-w-[820px] flex-col gap-2.5 bg-transparent py-0.5">
          <details className="group/process text-[13px] text-[#374151]">
            <summary className="flex cursor-pointer list-none items-center gap-1 text-[12px] text-[#8C9198] select-none marker:hidden [&::-webkit-details-marker]:hidden">
              <span className="font-normal text-[#6B7280]">过程({processSteps.length})</span>
              <span className="inline-block h-[7px] w-[7px] -rotate-45 border-r-[1.5px] border-b-[1.5px] border-current text-[#8C9198] opacity-0 transition duration-150 group-hover:opacity-100 group-open/process:rotate-45" />
            </summary>
            <div className="mt-3 flex flex-col gap-3.5 border-l border-dashed border-[#E5E7EB] pl-3.5">
              {processSteps.length ? processSteps.map((step, index) => (
                <div key={step.id} className="flex flex-col gap-1.5">
                  <div className="text-[11px] font-bold tracking-[0.04em] text-[#8C9198] uppercase">Step {index + 1}</div>
                  <div className="whitespace-pre-wrap text-[13px] leading-6 text-[#374151]">{step.thought}</div>
                  {step.tool ? (
                    <ToolActionBadge tool={step.tool} />
                  ) : null}
                </div>
              )) : (
                <div className="text-[13px] leading-6 text-[#8C9198]">暂无可展开的过程。</div>
              )}
            </div>
          </details>
          <div className={verdict ? "flex items-center gap-2 text-[13px] leading-6 text-[#374151]" : "text-[13px] leading-6 text-[#374151]"}>
            {verdict ? (
              <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-semibold leading-none ${verdict.tone === "ok" ? "bg-[#E8F5E9] text-[#25663A]" : "bg-[#FFF3CD] text-[#8A6D3B]"}`}>
                {verdict.label}
              </span>
            ) : null}
            <p className="whitespace-pre-wrap">{response}</p>
          </div>
        </div>
      </div>
    </article>
  );
}

function InteractionMessage({ children, time }: { children: ReactNode; time?: string }) {
  return (
    <article className="group relative grid grid-cols-[42px_minmax(0,1fr)] gap-3 md:grid-cols-[42px_minmax(0,1fr)]">
      <div className="grid h-[42px] w-[42px] place-items-center rounded-full border border-[#E5E7EB] bg-white text-[13px] font-bold text-[#64748B]">
        K
      </div>
      <div className="min-w-0 pt-0.5">
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-bold text-[#1F2328]">KiKi</span>
          {time ? <span className="text-[12px] text-[#8C9198] opacity-0 transition-opacity duration-150 group-hover:opacity-100">{time}</span> : null}
        </div>
        <div className="max-w-[820px] py-0.5">{children}</div>
      </div>
    </article>
  );
}

function UserSubmittedMessage({ text, time }: { text: string; time?: string }) {
  return (
    <article className="group relative grid grid-cols-[42px_minmax(0,1fr)] gap-3 md:grid-cols-[42px_minmax(0,1fr)]">
      <div className="grid h-[42px] w-[42px] place-items-center rounded-full border border-[#E5E7EB] bg-white text-[12px] font-bold text-[#64748B]">
        你
      </div>
      <div className="min-w-0 pt-0.5">
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-bold text-[#1F2328]">你</span>
          {time ? <span className="text-[12px] text-[#8C9198] opacity-0 transition-opacity duration-150 group-hover:opacity-100">{time}</span> : null}
        </div>
        <p className="max-w-[720px] whitespace-pre-wrap text-[13px] leading-6 text-[#374151]">{text}</p>
      </div>
    </article>
  );
}

function TimelineGroups({ groups, agentRunPlan }: { groups: TimelineGroup[]; agentRunPlan?: AgentRunPlan }) {
  return (
    <>
      {groups.map((group, index) => (
        <AgentMessage
          key={group.id}
          group={group}
          verdict={buildVerdict(group, agentRunPlan, isLastReviewerGroup(groups, index))}
        />
      ))}
    </>
  );
}

export function TaskExecutionTimeline({
  steps,
  agentRunPlan,
  interactionTurn,
  userSubmissionText,
  interactionTime,
}: {
  steps: TaskExecutionStep[];
  agentRunPlan?: AgentRunPlan;
  interactionTurn?: ReactNode;
  userSubmissionText?: string;
  interactionTime?: string;
}) {
  const visibleSteps = mergeAssistantProcessSteps(steps.filter(isVisibleExecutionStep));
  const resumeStepIndex = interactionTurn ? visibleSteps.findIndex(isResumeSubmissionStep) : -1;
  const beforeInteractionSteps = resumeStepIndex >= 0 ? visibleSteps.slice(0, resumeStepIndex) : visibleSteps;
  const afterInteractionSteps = resumeStepIndex >= 0 ? visibleSteps.slice(resumeStepIndex) : [];
  const beforeGroups = buildGroups(beforeInteractionSteps, agentRunPlan);
  const afterGroups = buildGroups(afterInteractionSteps, agentRunPlan);
  const fallbackGroups = groupsFromPlan(agentRunPlan);
  const groups = beforeGroups.length || afterGroups.length || interactionTurn ? beforeGroups : fallbackGroups;

  if (groups.length === 0 && afterGroups.length === 0 && !interactionTurn) {
    return (
      <div className="border border-dashed border-[#E5E7EB] bg-[#F8F9FB] px-4 py-6 text-sm text-[#8C9198]">
        暂无执行链路。
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <TimelineGroups groups={groups} agentRunPlan={agentRunPlan} />
      {interactionTurn ? <InteractionMessage time={interactionTime}>{interactionTurn}</InteractionMessage> : null}
      {userSubmissionText ? <UserSubmittedMessage text={userSubmissionText} time={interactionTime} /> : null}
      <TimelineGroups groups={afterGroups} agentRunPlan={agentRunPlan} />
    </div>
  );
}

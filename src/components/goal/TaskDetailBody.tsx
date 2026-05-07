"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { cn } from "@/lib/utils";
import type { Goal, Task } from "@/types/dora";

const TASK_TYPE_LABEL: Record<Task["taskType"], string> = {
  daily_repeat: "每日重复",
  one_shot: "一次性",
  monitoring: "监控追踪",
};

const EXECUTION_LABEL: Record<Task["executionKind"], string> = {
  flashcard: "记忆闪卡",
  listening_qa: "听力问答",
  reading_digest: "阅读摘要",
  confirm_action: "确认执行",
  draft_review: "草稿审阅",
  freeform_chat: "自由对话",
};

/**
 * 任务详情主体，供侧栏 (TaskDetailDrawer) 与全屏页 (TaskDetailPage) 复用。
 * - 顶部摘要：标题 + 状态 + 进度
 * - 基本信息：默认折叠，点击展开
 * - 任务内容（描述）
 * - 未完成任务通知卡片列表：时间倒序，最新在上，未读红点
 */
export function TaskDetailBody({ goal, task }: { goal: Goal; task: Task }) {
  const [metaOpen, setMetaOpen] = useState(false);
  const [completedOpen, setCompletedOpen] = useState(false);

  const taskState = getTaskDisplayState(task);
  const statusLabel =
    taskState === "completed" ? "已完成" : taskState === "in_progress" ? "进行中" : "待开始";
  const cleanTitle = task.title.replace(/^任务\d+：/, "");

  // 未完成通知：排除 completed，按 createdAt 倒序
  const pendingInstances = [...task.instances]
    .filter((item) => item.status !== "completed")
    .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));

  // 已完成通知：按 createdAt 倒序
  const completedInstances = [...task.instances]
    .filter((item) => item.status === "completed")
    .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));

  return (
    <div>
      <h2 className="text-[22px] font-semibold tracking-[-0.01em] text-[#1F2328]">{cleanTitle}</h2>
      <div className="mt-3 flex items-center gap-2">
        <span
          className={cn(
            "inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium",
            taskState === "completed"
              ? "bg-[#E5E7EB] text-[#6B7280]"
              : taskState === "in_progress"
                ? "bg-[#DDE1E7] text-[#1F2328]"
                : "bg-[#F5F6F8] text-[#8C9198]",
          )}
        >
          {statusLabel}
        </span>
        <span className="text-[12px] text-[#8C9198]">完成进度 {task.progress}%</span>
      </div>

      <div className="mt-5 h-1 overflow-hidden rounded-full bg-[#E5E7EB]">
        <div className="h-full rounded-full bg-[#1F2328]" style={{ width: `${task.progress}%` }} />
      </div>

      {/* 任务信息 - 默认折叠 */}
      <section className="mt-6">
        <button
          type="button"
          onClick={() => setMetaOpen((prev) => !prev)}
          className="flex w-full items-center justify-between rounded-lg border border-[#E5E7EB] bg-[#F8F9FB] px-4 py-2.5 text-[13px] text-[#1F2328] hover:border-[#1F2328]"
        >
          <span className="font-medium">任务信息</span>
          {metaOpen ? (
            <ChevronDown className="h-4 w-4 text-[#6B7280]" />
          ) : (
            <ChevronRight className="h-4 w-4 text-[#6B7280]" />
          )}
        </button>
        {metaOpen ? (
          <div className="mt-3 rounded-lg border border-[#E5E7EB] bg-white px-4 py-4">
            <div className="grid grid-cols-[88px_1fr] gap-x-4 gap-y-3 text-[13px]">
              <MetaLabel>任务类型</MetaLabel>
              <MetaValue>{TASK_TYPE_LABEL[task.taskType]}</MetaValue>

              <MetaLabel>执行周期</MetaLabel>
              <MetaValue>
                {task.taskType === "daily_repeat"
                  ? "每日"
                  : task.taskType === "one_shot"
                    ? "一次性"
                    : "长期"}
              </MetaValue>

              <MetaLabel>触发时间</MetaLabel>
              <MetaValue>{task.triggerRule}</MetaValue>

              <MetaLabel>交付物</MetaLabel>
              <MetaValue>{task.expectedOutcome || "—"}</MetaValue>

              <MetaLabel>执行方式</MetaLabel>
              <MetaValue>{EXECUTION_LABEL[task.executionKind]}</MetaValue>

              {task.deadline ? (
                <>
                  <MetaLabel>截止时间</MetaLabel>
                  <MetaValue>{new Date(task.deadline).toISOString().slice(0, 10)}</MetaValue>
                </>
              ) : null}
            </div>

            {task.description ? (
              <div className="mt-4 border-t border-[#E5E7EB] pt-4">
                <div className="mb-2 text-[12px] text-[#8C9198]">任务内容</div>
                <p className="whitespace-pre-wrap text-[13px] leading-6 text-[#1F2328]">
                  {task.description}
                </p>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      {/* 未完成通知卡片列表 */}
      <section className="mt-7">
        <h3 className="mb-3 text-[12px] font-medium text-[#6B7280]">
          未完成通知
          {pendingInstances.length > 0 ? (
            <span className="ml-2 text-[#8C9198]">（{pendingInstances.length}）</span>
          ) : null}
        </h3>
        {pendingInstances.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[#E5E7EB] bg-[#F8F9FB] px-4 py-6 text-center text-[12px] text-[#8C9198]">
            暂无未完成通知
          </div>
        ) : (
          <div className="space-y-3">
            {pendingInstances.map((item) => {
              const unread = item.status === "pending" || item.status === "awaiting_user";
              return (
                <Link
                  key={item.id}
                  href={`/goals/${goal.id}/tasks/${task.id}?view=exec&instanceId=${item.id}`}
                  className="relative block rounded-[12px] border border-[#E5E7EB] bg-white px-4 py-3.5 hover:border-[#1F2328]"
                >
                  {unread ? (
                    <span
                      aria-label="未读"
                      className="absolute right-3 top-3 inline-flex h-2 w-2 rounded-full bg-[#E5484D]"
                    />
                  ) : null}
                  <div className="flex items-center justify-between gap-3 text-[12px] text-[#8C9198]">
                    <span>{item.dateLabel}</span>
                    <span
                      className={cn(
                        "rounded-md px-2 py-0.5 text-[11px]",
                        item.status === "awaiting_user"
                          ? "bg-[#FFF3CD] text-[#8A6D3B]"
                          : item.status === "in_progress"
                            ? "bg-[#DDE1E7] text-[#1F2328]"
                            : "bg-[#F5F6F8] text-[#6B7280]",
                      )}
                    >
                      {instanceStatusLabel(item.status)}
                    </span>
                  </div>
                  <p className="mt-2 text-[13px] leading-6 text-[#1F2328]">{item.intro}</p>
                  <div className="mt-2 text-[12px] text-[#1F2328]">进入处理 →</div>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      {/* 已完成通知卡片列表 - 默认折叠 */}
      <section className="mt-6">
        <button
          type="button"
          onClick={() => setCompletedOpen((prev) => !prev)}
          className="mb-3 flex w-full items-center justify-between text-left text-[12px] font-medium text-[#6B7280] hover:text-[#1F2328]"
        >
          <span>
            已完成通知
            {completedInstances.length > 0 ? (
              <span className="ml-2 text-[#8C9198]">（{completedInstances.length}）</span>
            ) : null}
          </span>
          {completedOpen ? (
            <ChevronDown className="h-4 w-4 text-[#6B7280]" />
          ) : (
            <ChevronRight className="h-4 w-4 text-[#6B7280]" />
          )}
        </button>
        {completedOpen ? (
          completedInstances.length === 0 ? (
            <div className="mt-3 rounded-lg border border-dashed border-[#E5E7EB] bg-[#F8F9FB] px-4 py-6 text-center text-[12px] text-[#8C9198]">
              暂无已完成通知
            </div>
          ) : (
            <div className="mt-3 space-y-3">
              {completedInstances.map((item) => (
                <Link
                  key={item.id}
                  href={`/goals/${goal.id}/tasks/${task.id}?view=exec&instanceId=${item.id}`}
                  className="block rounded-[12px] border border-[#E5E7EB] bg-white px-4 py-3.5 hover:border-[#1F2328]"
                >
                  <div className="flex items-center justify-between gap-3 text-[12px] text-[#8C9198]">
                    <span>{item.dateLabel}</span>
                    <span className="rounded-md bg-[#E5E7EB] px-2 py-0.5 text-[11px] text-[#6B7280]">
                      已完成
                    </span>
                  </div>
                  <p className="mt-2 text-[13px] leading-6 text-[#1F2328]">{item.intro}</p>
                  <div className="mt-2 text-[12px] text-[#8C9198]">查看详情 →</div>
                </Link>
              ))}
            </div>
          )
        ) : null}
      </section>
    </div>
  );
}

function MetaLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[12px] leading-6 text-[#8C9198]">{children}</div>;
}
function MetaValue({ children }: { children: React.ReactNode }) {
  return <div className="text-[13px] leading-6 text-[#1F2328]">{children}</div>;
}

function getTaskDisplayState(task: Task) {
  const latestStatus = task.instances[0]?.status;
  if (latestStatus === "completed" || task.progress >= 100) return "completed" as const;
  if (latestStatus === "awaiting_user" || latestStatus === "in_progress")
    return "in_progress" as const;
  if (latestStatus === "pending") return task.progress > 0 ? ("in_progress" as const) : ("pending" as const);
  return task.progress > 0 ? ("in_progress" as const) : ("pending" as const);
}

function instanceStatusLabel(status: Task["instances"][number]["status"]) {
  if (status === "completed") return "已完成";
  if (status === "in_progress") return "进行中";
  if (status === "awaiting_user") return "待确认";
  return "待处理";
}

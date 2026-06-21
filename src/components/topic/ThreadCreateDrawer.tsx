"use client";

import { X } from "lucide-react";
import { useEffect, useState } from "react";

import { createSubGoalCommand } from "@/lib/api/goal-commands";
import { isImeCompositionKeyEvent } from "@/lib/browser/ime";
import { createIdempotencyKey, deriveOpaqueId } from "@/lib/opaqueIds";
import { useGoalStore } from "@/stores/goalStore";

type Props = {
  open: boolean;
  goalId: string;
  onClose: () => void;
};

export function ThreadCreateDrawer({ open, goalId, onClose }: Props) {
  const applyGoalsProjection = useGoalStore((state) => state.applyGoalsProjection);
  const goalProjectionRevision = useGoalStore((state) => state.goalProjectionRevision);
  const addPendingSubGoalCreate = useGoalStore((state) => state.addPendingSubGoalCreate);
  const removePendingSubGoalCreate = useGoalStore((state) => state.removePendingSubGoalCreate);
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) setTitle("");
  }, [open]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  const handleSubmit = async () => {
    const trimmed = title.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    const idempotencyKey = createIdempotencyKey(
      "goal.create_sub_goal",
      goalId,
      trimmed,
      `${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    );
    const pendingSubGoalId = deriveOpaqueId("sg", idempotencyKey);
    addPendingSubGoalCreate({
      id: pendingSubGoalId,
      goalId,
      idempotencyKey,
      createdAt: new Date().toISOString(),
      subGoal: {
        id: pendingSubGoalId,
        goalId,
        title: trimmed,
        tasks: [],
      },
    });
    onClose();
    try {
      const result = await createSubGoalCommand({
        goalId,
        title: trimmed,
        baseRevision: goalProjectionRevision,
        idempotencyKey,
      });
      applyGoalsProjection(result.goals, result.revision);
      removePendingSubGoalCreate(pendingSubGoalId);
    } catch (error) {
      removePendingSubGoalCreate(pendingSubGoalId);
      window.alert(error instanceof Error ? error.message : "线程创建失败");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30" onClick={onClose} />
        <aside className="fixed inset-y-0 right-0 z-50 flex h-dvh w-full flex-col border-l border-[#E5E7EB] bg-white md:h-screen md:w-[420px]">
        <div className="flex items-center justify-between border-b border-[#E5E7EB] px-5 py-4">
          <h3 className="text-sm font-semibold text-[#1F2328]">添加线程</h3>
          <button type="button" className="rounded-md p-1.5 text-[#6B7280] hover:bg-[#F5F6F8]" onClick={onClose} aria-label="关闭">
            <X className="h-4 w-4" />
          </button>
        </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-5 md:py-5">
          <label className="text-xs font-medium text-[#6B7280]">线程标题</label>
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="例：完成一轮完整模考"
            className="mt-2 w-full rounded-lg border border-[#E5E7EB] bg-[#F5F6F8] px-3 py-2 text-sm text-[#1F2328] outline-none focus:border-[#1F2328]"
            onKeyDown={(e) => {
              if (isImeCompositionKeyEvent(e)) return;
              if (e.key === "Enter") handleSubmit();
            }}
          />
          <p className="mt-3 text-xs leading-5 text-[#8C9198]">线程创建后，你可以继续在里面添加具体任务。</p>
        </div>
          <div className="flex items-center justify-end gap-2 border-t border-[#E5E7EB] px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-4 md:px-5 md:pb-4">
          <button type="button" className="rounded-lg border border-[#E5E7EB] bg-[#F5F6F8] px-3 py-1.5 text-sm text-[#1F2328]" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            disabled={!title.trim() || submitting}
            onClick={handleSubmit}
            className="rounded-lg bg-[#1F2328] px-3 py-1.5 text-sm text-white disabled:opacity-40"
          >
            创建
          </button>
        </div>
      </aside>
    </>
  );
}

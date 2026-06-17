"use client";

import { ExpandableContentCard } from "@/components/common/ExpandableContentCard";
import { buildInstanceCardTitle } from "@/components/task/ExecutionResultBody";
import { GenericAgentResultView } from "@/components/task/GenericAgentResultView";
import type { Task, TaskInstance } from "@/types/kiki";
import type { TaskResult } from "@/types/taskResult";

const INLINE_RESULT_MAX_HEIGHT = 520;

function hasAgentDeliverable(instance: TaskInstance) {
  const taskResult = instance.result?.taskResult;
  return Boolean(taskResult?.blocks?.length || taskResult?.artifactRefs?.length);
}

function hasCompletedAgentResult(instance: TaskInstance) {
  return instance.status === "completed" || instance.result?.taskResult?.status === "done";
}

function hasExpandableInteractiveDeliverable(taskResult: TaskResult) {
  if ((taskResult.blocks ?? []).length > 0) return true;
  if (taskResult.meta?.interactiveSurfaceKind !== "webapp") return false;
  return Boolean(
    taskResult.artifactRefs?.some((ref) => ref.kind === "webapp" || ref.kind === "external_embed"),
  );
}

function isPureFileDeliverable(instance: TaskInstance) {
  const taskResult = instance.result?.taskResult;
  if (!taskResult) return false;
  return hasAgentDeliverable(instance) && !hasExpandableInteractiveDeliverable(taskResult);
}

export function canRenderInlineAgentResult(_task: Task, instance: TaskInstance) {
  void _task;
  return hasCompletedAgentResult(instance) && hasAgentDeliverable(instance);
}

function buildResultViewProps(task: Task, instance: TaskInstance) {
  return {
    summary: instance.result?.summary,
    finalMessage: instance.result?.finalMessage,
    taskResult: instance.result?.taskResult,
    artifacts: instance.result?.artifacts,
    structuredOutput: instance.result?.structuredOutput,
    notification: instance.notification,
  };
}

export function TaskInlineResultView({
  task,
  instance,
  onExpandStart,
}: {
  task: Task;
  instance: TaskInstance;
  onExpandStart?: () => void;
}) {
  if (!canRenderInlineAgentResult(task, instance)) return null;

  const title = buildInstanceCardTitle(task, instance);
  const resultProps = buildResultViewProps(task, instance);

  if (isPureFileDeliverable(instance)) {
    return (
      <div className="max-h-[520px] overflow-y-auto overscroll-contain">
        <GenericAgentResultView {...resultProps} />
      </div>
    );
  }

  return (
    <ExpandableContentCard
      title={title}
      maxHeight={INLINE_RESULT_MAX_HEIGHT}
      onExpandStart={onExpandStart}
      renderContent={({ expandButton, bodyRef, bodyOverlay, clipMaxHeight, expanded }) => (
        <GenericAgentResultView
          {...resultProps}
          presentationClip={{
            headerActions: expandButton,
            clipMaxHeight,
            bodyRef,
            bodyOverlay,
            expanded,
          }}
        />
      )}
    />
  );
}

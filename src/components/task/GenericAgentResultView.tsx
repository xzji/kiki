"use client";

import type { Ref, ReactNode } from "react";

import { ArtifactRefList } from "@/components/execution/ArtifactRenderer";
import { TaskResultBlockView } from "@/components/execution/BlockRenderer";
import { DeliverableArticle } from "@/components/execution/DeliverableArticle";
import { ExternalEmbedSurface } from "@/components/execution/ExternalEmbedSurface";
import { SandboxedWebAppSurface } from "@/components/execution/SandboxedWebAppSurface";
import { isPendingUserPlaceholderTaskResult } from "@/lib/taskInstance/awaitingDisplayModel";
import { filterTaskResultForPresentation } from "@/lib/taskResult/presentationFilter";
import type { TaskInstanceNotificationState } from "@/types/kiki";
import type { TaskResult } from "@/types/taskResult";

export type ResultPresentationClip = {
  headerActions?: ReactNode;
  clipMaxHeight?: number;
  bodyRef?: Ref<HTMLDivElement>;
  bodyOverlay?: ReactNode;
};

const PRESENTATION_LABEL: Record<NonNullable<TaskResult["meta"]["presentation"]>, string> = {
  summary_card: "摘要卡片",
  visual_report: "可视化报告",
  comparison_table: "对比表",
  checklist: "检查清单",
  timeline: "时间线",
  document: "结构化文档",
  dashboard: "数据看板",
  handoff_package: "交付包",
};

function deliverableLabel(taskResult: TaskResult) {
  const presentationLabel = taskResult.meta.presentation
    ? PRESENTATION_LABEL[taskResult.meta.presentation]
    : taskResult.meta?.interactiveSurfaceKind === "webapp"
      ? "交互应用"
      : "结构化产物";
  return `产出物 · ${presentationLabel}`;
}

function hasInteractiveDeliverable(taskResult: TaskResult) {
  if ((taskResult.blocks ?? []).length > 0) return true;
  if (taskResult.meta?.interactiveSurfaceKind !== "webapp") return false;
  return Boolean(
    taskResult.artifactRefs?.some((ref) => ref.kind === "webapp" || ref.kind === "external_embed"),
  );
}

function InteractiveRenderSurface({
  taskResult,
  embedded = false,
}: {
  taskResult: TaskResult;
  embedded?: boolean;
}) {
  const blocks = taskResult.blocks ?? [];
  const meta = taskResult.meta;
  if (meta?.interactiveSurfaceKind === "webapp") {
    const externalEmbedRef = taskResult.artifactRefs?.find((ref) => ref.kind === "external_embed");
    const webappRef = taskResult.artifactRefs?.find((ref) => ref.kind === "webapp");
    if (externalEmbedRef) return <ExternalEmbedSurface artifact={externalEmbedRef} />;
    if (webappRef) return <SandboxedWebAppSurface artifact={webappRef} />;
    return null;
  }
  if (!blocks.length) return null;
  return <TaskResultBlockView result={taskResult} embedded={embedded} />;
}

function FileArtifactSurface({ taskResult }: { taskResult: TaskResult }) {
  const hasInteractiveSurface = hasInteractiveDeliverable(taskResult);
  return <ArtifactRefList refs={taskResult.artifactRefs} hasInteractiveSurface={hasInteractiveSurface} />;
}

export function GenericAgentResultView({
  summary,
  finalMessage,
  taskResult,
  artifacts,
  structuredOutput,
  notification,
  hideSummaryCard = false,
  hidePendingUserPlaceholder = false,
  presentationClip,
}: {
  summary?: string;
  finalMessage?: string;
  taskResult?: TaskResult;
  artifacts?: unknown[];
  structuredOutput?: Record<string, unknown> | null;
  notification?: TaskInstanceNotificationState;
  hideSummaryCard?: boolean;
  hidePendingUserPlaceholder?: boolean;
  presentationClip?: ResultPresentationClip;
}) {
  void summary;
  void finalMessage;
  void structuredOutput;
  void notification;
  void hideSummaryCard;
  void artifacts;

  if (!taskResult) return null;
  if (hidePendingUserPlaceholder && isPendingUserPlaceholderTaskResult(taskResult)) return null;
  const presentationTaskResult = filterTaskResultForPresentation(taskResult);
  const interactive = (
    <InteractiveRenderSurface taskResult={presentationTaskResult} embedded={Boolean(presentationClip?.clipMaxHeight)} />
  );
  const files = <FileArtifactSurface taskResult={presentationTaskResult} />;

  if (presentationClip?.clipMaxHeight && hasInteractiveDeliverable(presentationTaskResult)) {
    return (
      <DeliverableArticle
        label={deliverableLabel(presentationTaskResult)}
        title={presentationTaskResult.title}
        headerActions={presentationClip.headerActions}
        clipMaxHeight={presentationClip.clipMaxHeight}
        bodyRef={presentationClip.bodyRef}
        bodyOverlay={presentationClip.bodyOverlay}
      >
        <div className="space-y-4">
          {interactive}
          {files}
        </div>
      </DeliverableArticle>
    );
  }

  return (
    <div className="space-y-4">
      {interactive}
      {files}
    </div>
  );
}

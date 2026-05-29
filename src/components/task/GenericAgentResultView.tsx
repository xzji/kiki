"use client";

import { ArtifactRefList } from "@/components/execution/ArtifactRenderer";
import { TaskResultBlockView } from "@/components/execution/BlockRenderer";
import { ExternalEmbedSurface } from "@/components/execution/ExternalEmbedSurface";
import { SandboxedWebAppSurface } from "@/components/execution/SandboxedWebAppSurface";
import { isPendingUserPlaceholderTaskResult } from "@/lib/taskInstance/awaitingDisplayModel";
import { filterTaskResultForPresentation } from "@/lib/taskResult/presentationFilter";
import type { TaskInstanceNotificationState } from "@/types/kiki";
import type { TaskResult } from "@/types/taskResult";

function InteractiveRenderSurface({ taskResult }: { taskResult: TaskResult }) {
  const blocks = taskResult.blocks ?? [];
  const meta = taskResult.meta;
  if (meta?.interactiveSurfaceKind === "webapp") {
    const externalEmbedRef = taskResult.artifactRefs?.find((ref) => ref.kind === "external_embed");
    if (externalEmbedRef) return <ExternalEmbedSurface artifact={externalEmbedRef} />;
    const webappRef = taskResult.artifactRefs?.find((ref) => ref.kind === "webapp");
    if (webappRef) return <SandboxedWebAppSurface artifact={webappRef} />;
  }
  if (!blocks.length) return null;
  return <TaskResultBlockView result={taskResult} />;
}

function FileArtifactSurface({ taskResult }: { taskResult: TaskResult }) {
  const hasInteractiveSurface = (taskResult.blocks ?? []).length > 0 || Boolean(taskResult.artifactRefs?.some((ref) => ref.kind === "webapp" || ref.kind === "external_embed"));
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
}: {
  summary?: string;
  finalMessage?: string;
  taskResult?: TaskResult;
  artifacts?: unknown[];
  structuredOutput?: Record<string, unknown> | null;
  notification?: TaskInstanceNotificationState;
  hideSummaryCard?: boolean;
  hidePendingUserPlaceholder?: boolean;
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

  return (
    <div className="space-y-4">
      <InteractiveRenderSurface taskResult={presentationTaskResult} />
      <FileArtifactSurface taskResult={presentationTaskResult} />
    </div>
  );
}

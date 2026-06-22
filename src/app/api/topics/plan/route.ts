import { NextRequest, NextResponse } from "next/server";

import { runTopicInitSagaWithDefaults } from "@/lib/server/topicPlanning";
import { adaptTopicInitSagaToGoalDraft } from "@/lib/server/goalPlanning/sagaDraftAdapter";
import { ensureConversationWorkspace } from "@/lib/server/workspace/conversationWorkspace";
import type { CliProcessEventInput, RuntimeEnvironment } from "@/types/runtime";
import { withAuth } from "@/lib/server/http/withAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RequestBody = {
  topicText: string;
  runtimeEnv: RuntimeEnvironment;
  conversationId?: string;
  conversationContext?: string;
  revisionFeedback?: string;
  previousPlanContext?: string;
  maxRefineLoops?: number;
  stream?: boolean;
};

function joinContextParts(parts: Array<string | undefined>) {
  return parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
}

async function POSTHandler(request: NextRequest) {
  const body = (await request.json()) as RequestBody;
  const topicText = body.topicText?.trim();

  if (!topicText) {
    return NextResponse.json({ reason: "topicText 不能为空" }, { status: 400 });
  }

  if (!body.runtimeEnv || body.runtimeEnv.type !== "local") {
    return NextResponse.json({ reason: "当前没有可用的本地 Claude 环境" }, { status: 400 });
  }

  try {
    const requestId =
      request.headers.get("x-topic-saga-request-id")?.trim() ||
      `topic-saga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const conversationId = body.conversationId?.trim();
    const workspace = conversationId ? ensureConversationWorkspace(conversationId) : undefined;
    const revisionFeedback = body.revisionFeedback?.trim() || undefined;
    const previousPlanContext = body.previousPlanContext?.trim() || undefined;
    const revisionContext = revisionFeedback
      ? joinContextParts([
          previousPlanContext ? `上一版主题规划摘要：\n${previousPlanContext}` : undefined,
          `用户对上一版规划的调整意见：\n${revisionFeedback}`,
        ])
      : undefined;
    const executePlan = async (onCliEvent?: (event: CliProcessEventInput) => void) => {
      const result = await runTopicInitSagaWithDefaults({
        topicId: `topic-saga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        topicText,
        conversationContext: joinContextParts([body.conversationContext, revisionContext]) || undefined,
        userContext: {
          command: revisionFeedback ? "/topic revision" : "/topic",
          initialRequest: topicText,
          conversationId,
          revisionFeedback,
          previousPlanContext,
        },
        cwd: workspace?.workspaceDir ?? process.cwd(),
        runtimeEnv: body.runtimeEnv,
        signal: request.signal,
        idempotencyKey: requestId,
        maxRefineLoops:
          typeof body.maxRefineLoops === "number" && Number.isFinite(body.maxRefineLoops)
            ? body.maxRefineLoops
            : undefined,
        onCliEvent,
      });

      if (result.status === "awaiting_user") {
        return {
          kind: "awaiting_user" as const,
          questions: result.awaitingQuestions ?? [],
          sagaId: result.saga.id,
        };
      }

      if (result.status !== "completed") {
        const reason = result.errorMessage || "5 角色 Saga 执行失败";
        console.error("[topics/plan] saga failed", {
          sagaId: result.saga.id,
          failedStep: result.failedStep,
          failedAgentRunId: result.failedAgentRunId,
          reason,
        });
        const error = new Error(reason) as Error & {
          sagaId?: string;
          failedStep?: string;
          failedAgentRunId?: string;
        };
        error.sagaId = result.saga.id;
        error.failedStep = result.failedStep;
        error.failedAgentRunId = result.failedAgentRunId;
        throw error;
      }

      const draft = adaptTopicInitSagaToGoalDraft({ topicText, result });
      return {
        kind: "planned" as const,
        draft,
        saga: {
          id: result.saga.id,
          refineLoops: result.refineLoops,
          forcedAccept: result.forcedAccept === true,
        },
      };
    };

    if (body.stream) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          let closed = false;
          const write = (frame: unknown) => {
            if (closed) return;
            try {
              controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
            } catch {
              closed = true;
            }
          };
          void executePlan((event) => write({ type: "cli_event", event }))
            .then((result) => write({ type: "result", result }))
            .catch((error: unknown) => {
              const typed = error as {
                message?: string;
                sagaId?: string;
                failedStep?: string;
                failedAgentRunId?: string;
              };
              write({
                type: "error",
                reason: typed.message || "5 角色 Saga 执行失败",
                sagaId: typed.sagaId,
                failedStep: typed.failedStep,
                failedAgentRunId: typed.failedAgentRunId,
              });
            })
            .finally(() => {
              if (closed) return;
              closed = true;
              try {
                controller.close();
              } catch {
                // The client may have already canceled the stream.
              }
            });
        },
      });
      return new NextResponse(stream, {
        headers: {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
        },
      });
    }

    return NextResponse.json(await executePlan());
  } catch (error) {
    const typed = error as {
      message?: string;
      sagaId?: string;
      failedStep?: string;
      failedAgentRunId?: string;
    };
    return NextResponse.json(
      {
        reason: typed.message || "5 角色 Saga 执行失败",
        sagaId: typed.sagaId,
        failedStep: typed.failedStep,
        failedAgentRunId: typed.failedAgentRunId,
      },
      { status: 500 },
    );
  }
}

export const POST = withAuth(POSTHandler);

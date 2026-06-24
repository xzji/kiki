import { NextRequest, NextResponse } from "next/server";

import { deleteClaudeSessionFile } from "@/lib/server/claudeSession";
import {
  cancelRuntimeJobsByConversationId,
  deleteRuntimeJobsByConversationId,
  releaseRuntimeJobLeasesByConversationId,
} from "@/lib/server/repositories/runtimeJobsRepository";
import { cancelActiveTunnelDispatchesByConversationId } from "@/lib/server/scheduling/taskDispatcher";
import {
  deleteConversationWorkspace,
  ensureConversationWorkspace,
  getConversationWorkspaceDir,
} from "@/lib/server/workspace/conversationWorkspace";
import { cleanupUserMemoryCandidatesForConversation } from "@/lib/server/memory/userMemoryCandidates";
import { withAuth } from "@/lib/server/http/withAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function POSTHandler(_: NextRequest, context: { params: Promise<{ conversationId: string }> }) {
  const { conversationId } = await context.params;
  const workspace = ensureConversationWorkspace(conversationId);
  return NextResponse.json({ ok: true, workspaceDir: workspace.workspaceDir, workspace });
}

async function DELETEHandler(request: NextRequest, context: { params: Promise<{ conversationId: string }> }) {
  try {
    const { conversationId } = await context.params;
    const body = (await request.json().catch(() => ({}))) as { claudeSessionId?: string };
    const workspaceDir = getConversationWorkspaceDir(conversationId);

    const cancelReason = "用户删除会话，终止关联任务执行";
    const cancelledActiveTunnelJobs = cancelActiveTunnelDispatchesByConversationId(conversationId, cancelReason);
    const cancelledJobs = cancelRuntimeJobsByConversationId(conversationId);
    releaseRuntimeJobLeasesByConversationId(conversationId);
    const deletedJobs = deleteRuntimeJobsByConversationId(conversationId);

    let deletedClaudeSession = false;
    if (body.claudeSessionId) {
      const result = await deleteClaudeSessionFile({
        sessionId: body.claudeSessionId,
        workingDirectory: workspaceDir,
      });
      deletedClaudeSession = result.deleted;
    }

    deleteConversationWorkspace(conversationId);
    await cleanupUserMemoryCandidatesForConversation(conversationId);
    return NextResponse.json({ ok: true, cancelledJobs, cancelledActiveTunnelJobs, deletedJobs, deletedClaudeSession });
  } catch (error) {
    return NextResponse.json(
      { ok: false, reason: error instanceof Error ? error.message : "清理会话 workspace 失败" },
      { status: 400 },
    );
  }
}

export const POST = withAuth(POSTHandler);
export const DELETE = withAuth(DELETEHandler);

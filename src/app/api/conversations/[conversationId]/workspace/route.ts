import { NextRequest, NextResponse } from "next/server";

import { deleteClaudeSessionFile } from "@/lib/server/claudeSession";
import {
  cancelRuntimeJobsByConversationId,
  deleteRuntimeJobsByConversationId,
  releaseRuntimeJobLeasesByConversationId,
} from "@/lib/server/repositories/runtimeJobsRepository";
import {
  deleteConversationWorkspace,
  ensureConversationWorkspace,
  getConversationWorkspaceDir,
} from "@/lib/server/workspace/conversationWorkspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_: NextRequest, context: { params: Promise<{ conversationId: string }> }) {
  const { conversationId } = await context.params;
  const workspace = ensureConversationWorkspace(conversationId);
  return NextResponse.json({ ok: true, workspaceDir: workspace.workspaceDir, workspace });
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ conversationId: string }> }) {
  try {
    const { conversationId } = await context.params;
    const body = (await request.json().catch(() => ({}))) as { claudeSessionId?: string };
    const workspaceDir = getConversationWorkspaceDir(conversationId);

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
    return NextResponse.json({ ok: true, cancelledJobs, deletedJobs, deletedClaudeSession });
  } catch (error) {
    return NextResponse.json(
      { ok: false, reason: error instanceof Error ? error.message : "清理会话 workspace 失败" },
      { status: 400 },
    );
  }
}

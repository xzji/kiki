import { NextRequest, NextResponse } from "next/server";

import { INITIAL_RUNTIME_ENVIRONMENTS } from "@/lib/runtime/defaultRuntimeEnvironments";
import {
  dispatchReadyGovernanceTickJobsToMachines,
  enqueueManualGovernanceTickJob,
  registerGovernanceTickTunnelCallbacks,
} from "@/lib/server/governance/governanceTickDispatcher";
import { withAuth } from "@/lib/server/http/withAuth";
import { readRuntimeEnvironmentsSnapshot } from "@/lib/server/runtime/stateSnapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MANUAL_GOVERNANCE_LEASE_OWNER = "cloud-orchestrator";

type Body = {
  kind?: unknown;
  entityId?: unknown;
};

function readBody(value: Body): { kind: "topic" | "thread"; entityId: string } | null {
  const kind = value.kind;
  const entityId = typeof value.entityId === "string" ? value.entityId.trim() : "";
  if (kind !== "topic" && kind !== "thread") return null;
  if (!entityId) return null;
  return { kind, entityId };
}

function logManualGovernanceTick(message: string, fields: Record<string, unknown> = {}) {
  console.info("[governance_tick_manual]", message, fields);
}

async function POSTHandler(request: NextRequest, context: { userId: string }) {
  const idempotencyKey = request.headers.get("Idempotency-Key")?.trim();
  if (!idempotencyKey) {
    return NextResponse.json({ ok: false, reason: "缺少 Idempotency-Key" }, { status: 400 });
  }

  const parsed = readBody((await request.json().catch(() => ({}))) as Body);
  if (!parsed) {
    return NextResponse.json({ ok: false, reason: "治理参数不完整" }, { status: 400 });
  }

  try {
    const job = enqueueManualGovernanceTickJob({
      targetKind: parsed.kind,
      entityId: parsed.entityId,
      idempotencyKey,
      userId: context.userId,
    });
    logManualGovernanceTick("manual governance job requested", {
      userId: context.userId,
      jobId: job.id,
      targetKind: job.targetKind,
      topicId: job.topicId,
      threadId: job.threadId,
      status: job.status,
    });

    registerGovernanceTickTunnelCallbacks();
    const runtimeEnvironments = readRuntimeEnvironmentsSnapshot(INITIAL_RUNTIME_ENVIRONMENTS);
    const runtimeEnv =
      runtimeEnvironments.find((environment) => environment.isDefault && environment.type === "local") ??
      runtimeEnvironments.find((environment) => environment.type === "local") ??
      runtimeEnvironments[0] ??
      null;
    const dispatch = dispatchReadyGovernanceTickJobsToMachines({
      leaseOwner: MANUAL_GOVERNANCE_LEASE_OWNER,
      limit: 10,
      llm: runtimeEnv
        ? {
            runtimeEnv,
            cwd: runtimeEnv.workingDirectory,
            permissionMode: runtimeEnv.permissionMode,
          }
        : undefined,
    });
    logManualGovernanceTick("manual governance dispatch attempted", {
      userId: context.userId,
      jobId: job.id,
      targetKind: job.targetKind,
      dispatched: dispatch.processed > 0,
      processed: dispatch.processed,
      skippedOffline: dispatch.skippedOffline,
      runtimeEnvId: runtimeEnv?.id,
    });

    return NextResponse.json({
      ok: true,
      job,
      dispatched: dispatch.processed > 0,
      skippedOffline: dispatch.skippedOffline,
    });
  } catch (error) {
    logManualGovernanceTick("manual governance request failed", {
      userId: context.userId,
      kind: parsed.kind,
      entityId: parsed.entityId,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { ok: false, reason: error instanceof Error ? error.message : "治理发起失败" },
      { status: 500 },
    );
  }
}

export const POST = withAuth(POSTHandler);

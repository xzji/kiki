import { getDatabase } from "@/lib/server/db/client";
import { appendGoalEventOnce } from "@/lib/server/repositories/goalEventLogRepository";
import type { ExecutionBlocker } from "@/types/executionBlocker";
import type { GoalServerLogEntry, GoalServerProgress } from "@/types/goalTelemetry";
import type { Goal, SubGoal, Task, TaskInstance } from "@/types/kiki";
import type { ExecutionTrajectoryStep } from "@/types/executionTrajectory";
import type { RuntimeEnvironment } from "@/types/runtime";

export type RuntimeJobStatus =
  | "queued"
  | "running"
  | "awaiting_user"
  | "completed"
  | "failed"
  | "cancelled";

export type RuntimeJobKind = "goal_task";

export type RuntimeJobPayload = {
  goal: Goal;
  subGoal: SubGoal;
  task: Task;
  instance: TaskInstance;
  runtimeEnv: RuntimeEnvironment;
  conversationWorkspaceDir?: string;
  taskWorkspaceDir?: string;
  resumeContext?: string;
};

export type RuntimeJobRecord = {
  id: string;
  taskInstanceId?: string;
  taskId?: string;
  goalId?: string;
  conversationId?: string;
  userId: string;
  kind: RuntimeJobKind;
  status: RuntimeJobStatus;
  requestId?: string;
  runtimeEnvId?: string;
  runtimeTransport: "local_daemon" | "cloud_control_plane";
  payload: RuntimeJobPayload;
  progress: GoalServerProgress | null;
  logs: GoalServerLogEntry[];
  trajectory: ExecutionTrajectoryStep[];
  blocker: ExecutionBlocker | null;
  result: Record<string, unknown> | null;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  availableAt?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  lastError?: string;
};

type RuntimeJobRow = {
  id: string;
  task_instance_id: string | null;
  task_id: string | null;
  goal_id: string | null;
  conversation_id: string | null;
  user_id: string;
  kind: RuntimeJobKind;
  status: RuntimeJobStatus;
  request_id: string | null;
  runtime_env_id: string | null;
  runtime_transport: "local_daemon" | "cloud_control_plane";
  payload_json: string;
  progress_json: string | null;
  logs_json: string | null;
  trajectory_json: string | null;
  blocker_json: string | null;
  result_json: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  available_at: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  last_error: string | null;
};

function parseNullableJson<T>(value: string | null): T | null {
  if (!value) return null;
  return JSON.parse(value) as T;
}

function mapRow(row: RuntimeJobRow): RuntimeJobRecord {
  return {
    id: row.id,
    taskInstanceId: row.task_instance_id ?? undefined,
    taskId: row.task_id ?? undefined,
    goalId: row.goal_id ?? undefined,
    conversationId: row.conversation_id ?? undefined,
    userId: row.user_id,
    kind: row.kind,
    status: row.status,
    requestId: row.request_id ?? undefined,
    runtimeEnvId: row.runtime_env_id ?? undefined,
    runtimeTransport: row.runtime_transport,
    payload: JSON.parse(row.payload_json) as RuntimeJobPayload,
    progress: parseNullableJson<GoalServerProgress>(row.progress_json),
    logs: parseNullableJson<GoalServerLogEntry[]>(row.logs_json) ?? [],
    trajectory: parseNullableJson<ExecutionTrajectoryStep[]>(row.trajectory_json) ?? [],
    blocker: parseNullableJson<ExecutionBlocker>(row.blocker_json),
    result: parseNullableJson<Record<string, unknown>>(row.result_json),
    leaseOwner: row.lease_owner ?? undefined,
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    availableAt: row.available_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    lastError: row.last_error ?? undefined,
  };
}

function nowIso() {
  return new Date().toISOString();
}

function appendRuntimeJobGoalEvent(input: Parameters<typeof appendGoalEventOnce>[0]) {
  try {
    return appendGoalEventOnce(input);
  } catch {
    return null;
  }
}

export function upsertRuntimeJob(record: RuntimeJobRecord) {
  const db = getDatabase();
  db.prepare(
    `
      INSERT INTO runtime_jobs (
        id, task_instance_id, task_id, goal_id, conversation_id, user_id, kind, status,
        request_id, runtime_env_id, runtime_transport, payload_json, progress_json, logs_json,
        trajectory_json, blocker_json, result_json, lease_owner, lease_expires_at, available_at, created_at, updated_at,
        started_at, finished_at, last_error
      ) VALUES (
        @id, @task_instance_id, @task_id, @goal_id, @conversation_id, @user_id, @kind, @status,
        @request_id, @runtime_env_id, @runtime_transport, @payload_json, @progress_json, @logs_json,
        @trajectory_json, @blocker_json, @result_json, @lease_owner, @lease_expires_at, @available_at, @created_at, @updated_at,
        @started_at, @finished_at, @last_error
      )
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        request_id = excluded.request_id,
        runtime_env_id = excluded.runtime_env_id,
        runtime_transport = excluded.runtime_transport,
        payload_json = excluded.payload_json,
        progress_json = excluded.progress_json,
        logs_json = excluded.logs_json,
        trajectory_json = excluded.trajectory_json,
        blocker_json = excluded.blocker_json,
        result_json = excluded.result_json,
        lease_owner = excluded.lease_owner,
        lease_expires_at = excluded.lease_expires_at,
        available_at = excluded.available_at,
        updated_at = excluded.updated_at,
        started_at = excluded.started_at,
        finished_at = excluded.finished_at,
        last_error = excluded.last_error
    `,
  ).run({
    id: record.id,
    task_instance_id: record.taskInstanceId ?? null,
    task_id: record.taskId ?? null,
    goal_id: record.goalId ?? null,
    conversation_id: record.conversationId ?? null,
    user_id: record.userId,
    kind: record.kind,
    status: record.status,
    request_id: record.requestId ?? null,
    runtime_env_id: record.runtimeEnvId ?? null,
    runtime_transport: record.runtimeTransport,
    payload_json: JSON.stringify(record.payload),
    progress_json: record.progress ? JSON.stringify(record.progress) : null,
    logs_json: JSON.stringify(record.logs),
    trajectory_json: JSON.stringify(record.trajectory),
    blocker_json: record.blocker ? JSON.stringify(record.blocker) : null,
    result_json: record.result ? JSON.stringify(record.result) : null,
    lease_owner: record.leaseOwner ?? null,
    lease_expires_at: record.leaseExpiresAt ?? null,
    available_at: record.availableAt ?? null,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    started_at: record.startedAt ?? null,
    finished_at: record.finishedAt ?? null,
    last_error: record.lastError ?? null,
  });
}

export function createQueuedRuntimeJob(
  payload: RuntimeJobPayload,
  input?: { requestId?: string; eventSource?: "scheduler" | "user" | "feedback" | "resume" },
) {
  const now = nowIso();
  const jobId = `job-${payload.instance.id}`;
  const record: RuntimeJobRecord = {
    id: jobId,
    taskInstanceId: payload.instance.id,
    taskId: payload.task.id,
    goalId: payload.goal.id,
    conversationId: payload.goal.conversationId,
    userId: "local-user",
    kind: "goal_task",
    status: "queued",
    requestId: input?.requestId,
    runtimeEnvId: payload.runtimeEnv.id,
    runtimeTransport: "local_daemon",
    payload,
    progress: null,
    logs: [],
    trajectory: [],
    blocker: null,
    result: null,
    availableAt: now,
    createdAt: now,
    updatedAt: now,
  };
  upsertRuntimeJob(record);
  appendRuntimeJobGoalEvent({
    goalId: payload.goal.id,
    taskId: payload.task.id,
    instanceId: payload.instance.id,
    kind: "instance.created",
    producedBy: input?.eventSource === "scheduler" || !input?.eventSource ? "scheduler" : "user",
    idempotencyKey: `instance.created:${payload.instance.id}`,
    createdAt: now,
    payload: {
      requestId: input?.requestId,
      status: payload.instance.status,
      runtimeEnvId: payload.runtimeEnv.id,
      source: input?.eventSource ?? "scheduler",
    },
  });
  return record;
}

export function getRuntimeJobByTaskInstanceId(taskInstanceId: string) {
  const db = getDatabase();
  const row = db
    .prepare(`SELECT * FROM runtime_jobs WHERE task_instance_id = ? ORDER BY updated_at DESC LIMIT 1`)
    .get(taskInstanceId) as RuntimeJobRow | undefined;
  return row ? mapRow(row) : null;
}

export function getRuntimeJobByRequestId(requestId: string) {
  const db = getDatabase();
  const row = db
    .prepare(`SELECT * FROM runtime_jobs WHERE request_id = ? ORDER BY updated_at DESC LIMIT 1`)
    .get(requestId) as RuntimeJobRow | undefined;
  return row ? mapRow(row) : null;
}

export function claimQueuedRuntimeJobs(input: { leaseOwner: string; limit: number; leaseMs?: number }) {
  const db = getDatabase();
  const leaseExpiresAt = new Date(Date.now() + (input.leaseMs ?? 2 * 60 * 1000)).toISOString();
  const now = nowIso();
  const rows = db
    .prepare(
      `
        SELECT * FROM runtime_jobs
        WHERE status = 'queued'
          AND (available_at IS NULL OR available_at <= ?)
        ORDER BY created_at ASC
        LIMIT ?
      `,
    )
    .all(now, input.limit) as RuntimeJobRow[];

  return rows.flatMap((row) => {
    const result = db.prepare(
      `
        UPDATE runtime_jobs
        SET status = 'running',
            lease_owner = ?,
            lease_expires_at = ?,
            started_at = COALESCE(started_at, ?),
            updated_at = ?
        WHERE id = ?
          AND status = 'queued'
      `,
    ).run(input.leaseOwner, leaseExpiresAt, now, now, row.id);
    if (result.changes === 0) return [];

    return {
      ...mapRow({
        ...row,
        status: "running",
        lease_owner: input.leaseOwner,
        lease_expires_at: leaseExpiresAt,
        started_at: row.started_at ?? now,
        updated_at: now,
      }),
      leaseOwner: input.leaseOwner,
      leaseExpiresAt,
      startedAt: row.started_at ?? now,
      updatedAt: now,
    };
  });
}

export function updateRuntimeJobExecution(
  jobId: string,
  updates: Partial<
    Pick<
      RuntimeJobRecord,
      | "status"
      | "payload"
      | "requestId"
      | "progress"
      | "logs"
      | "trajectory"
      | "blocker"
      | "result"
      | "lastError"
      | "finishedAt"
      | "leaseOwner"
      | "leaseExpiresAt"
    >
  >,
) {
  const existing = getRuntimeJob(jobId);
  if (!existing) return null;
  const next: RuntimeJobRecord = {
    ...existing,
    ...updates,
    updatedAt: nowIso(),
  };
  upsertRuntimeJob(next);
  if (updates.status && updates.status !== existing.status && next.goalId && next.taskId && next.taskInstanceId) {
    appendRuntimeJobGoalEvent({
      goalId: next.goalId,
      taskId: next.taskId,
      instanceId: next.taskInstanceId,
      kind: "instance.status_changed",
      producedBy: "worker",
      idempotencyKey: `instance.status_changed:${next.taskInstanceId}:${existing.status}->${updates.status}:${next.updatedAt}`,
      createdAt: next.updatedAt,
      payload: {
        previousStatus: existing.status,
        nextStatus: updates.status,
        requestId: next.requestId,
        reason: updates.lastError,
      },
    });
  }
  if (updates.progress && next.goalId && next.taskId && next.taskInstanceId) {
    appendRuntimeJobGoalEvent({
      goalId: next.goalId,
      taskId: next.taskId,
      instanceId: next.taskInstanceId,
      kind: "instance.progress",
      producedBy: "worker",
      idempotencyKey: `instance.progress:${next.taskInstanceId}:${next.updatedAt}`,
      createdAt: next.updatedAt,
      payload: {
        requestId: next.requestId,
        message: updates.progress.message,
        progress: updates.progress,
        trajectoryLength: updates.trajectory?.length ?? next.trajectory.length,
      },
    });
  }
  return next;
}

export function markRuntimeJobAwaiting(jobId: string, input: { reason: string; blocker?: unknown }) {
  const existing = getRuntimeJob(jobId);
  if (!existing) return null;
  return updateRuntimeJobExecution(jobId, {
    status: "awaiting_user",
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    lastError: undefined,
    result: {
      ...(existing.result ?? {}),
      awaitingUser: true,
      awaitingReason: input.reason,
      contextBlocker: input.blocker,
    },
  });
}

export function isRuntimeJobLeaseHeld(jobId: string, leaseOwner: string) {
  const job = getRuntimeJob(jobId);
  return Boolean(job && job.status === "running" && job.leaseOwner === leaseOwner);
}

export function getRuntimeJob(jobId: string) {
  const db = getDatabase();
  const row = db.prepare(`SELECT * FROM runtime_jobs WHERE id = ? LIMIT 1`).get(jobId) as RuntimeJobRow | undefined;
  return row ? mapRow(row) : null;
}

export function renewRuntimeJobLease(jobId: string, input: { leaseOwner: string; leaseMs?: number }) {
  const db = getDatabase();
  const now = nowIso();
  const leaseExpiresAt = new Date(Date.now() + (input.leaseMs ?? 2 * 60 * 1000)).toISOString();
  const result = db
    .prepare(
      `
        UPDATE runtime_jobs
        SET lease_owner = ?,
            lease_expires_at = ?,
            updated_at = ?
        WHERE id = ?
          AND status = 'running'
          AND (lease_owner IS NULL OR lease_owner = ?)
      `,
    )
    .run(input.leaseOwner, leaseExpiresAt, now, jobId, input.leaseOwner);
  return { renewed: result.changes > 0, leaseExpiresAt };
}

export function releaseExpiredRuntimeJobLeases() {
  const db = getDatabase();
  const now = nowIso();
  db.prepare(
    `
      UPDATE runtime_jobs
      SET status = CASE
            WHEN status = 'running' THEN 'queued'
            ELSE status
          END,
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = ?
      WHERE lease_expires_at IS NOT NULL
        AND lease_expires_at <= ?
        AND status IN ('running')
    `,
  ).run(now, now);
}

export function cancelRuntimeJobsByConversationId(conversationId: string) {
  const db = getDatabase();
  const now = nowIso();
  const result = db
    .prepare(
      `
        UPDATE runtime_jobs
        SET status = 'cancelled',
            lease_owner = NULL,
            lease_expires_at = NULL,
            finished_at = COALESCE(finished_at, ?),
            updated_at = ?
        WHERE conversation_id = ?
          AND status IN ('queued', 'running', 'awaiting_user')
      `,
    )
    .run(now, now, conversationId);
  return result.changes;
}

export function cancelRuntimeJobByTaskRun(input: { requestId?: string; taskInstanceId?: string }) {
  const db = getDatabase();
  const now = nowIso();
  const conditions: string[] = [];
  const params: string[] = [];
  if (input.requestId) {
    conditions.push("request_id = ?");
    params.push(input.requestId);
  }
  if (input.taskInstanceId) {
    conditions.push("task_instance_id = ?");
    params.push(input.taskInstanceId);
  }
  if (!conditions.length) return null;
  const row = db
    .prepare(
      `
        SELECT * FROM runtime_jobs
        WHERE (${conditions.join(" OR ")})
          AND status IN ('queued', 'running', 'awaiting_user')
        ORDER BY updated_at DESC
        LIMIT 1
      `,
    )
    .get(...params) as RuntimeJobRow | undefined;
  if (!row) return null;
  db.prepare(
    `
      UPDATE runtime_jobs
      SET status = 'cancelled',
          lease_owner = NULL,
          lease_expires_at = NULL,
          finished_at = COALESCE(finished_at, ?),
          updated_at = ?,
          last_error = ?
      WHERE id = ?
    `,
  ).run(now, now, "用户手动停止任务执行", row.id);
  return getRuntimeJob(row.id);
}

export function releaseRuntimeJobLeasesByConversationId(conversationId: string) {
  const db = getDatabase();
  const now = nowIso();
  const result = db
    .prepare(
      `
        UPDATE runtime_jobs
        SET lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = ?
        WHERE conversation_id = ?
          AND lease_owner IS NOT NULL
      `,
    )
    .run(now, conversationId);
  return result.changes;
}

export function deleteRuntimeJobsByConversationId(conversationId: string) {
  const db = getDatabase();
  const result = db.prepare(`DELETE FROM runtime_jobs WHERE conversation_id = ?`).run(conversationId);
  return result.changes;
}

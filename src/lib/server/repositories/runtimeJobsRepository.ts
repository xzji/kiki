import { resolveCurrentUserId } from "@/lib/server/context/resolveUserId";
import { getDatabase } from "@/lib/server/db/client";
import { isCloudOrchestratorMode } from "@/lib/server/orchestrator/orchestratorConfig";
import {
  createIdempotencyKey,
  migrateGoalIds,
  migrateTaskIds,
  migrateTaskInstanceIds,
  normalizeGoalId,
  normalizeInstanceId,
  normalizeSubGoalId,
  normalizeTaskId,
} from "@/lib/opaqueIds";
import { appendGoalEventOnce } from "@/lib/server/repositories/goalEventLogRepository";
import type { ExecutionBlocker } from "@/types/executionBlocker";
import type { GoalServerLogEntry, GoalServerProgress } from "@/types/goalTelemetry";
import type { Goal, SubGoal, Task, TaskInstance } from "@/types/kiki";
import type { ExecutionTrajectoryStep } from "@/types/executionTrajectory";
import type { RuntimeEnvironment, RuntimeToolPermissionRule } from "@/types/runtime";

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
  resumeSessionId?: string;
  executionMachineId?: string;
  toolPermissionSessionRules?: RuntimeToolPermissionRule[];
};

export type RuntimeJobRecord = {
  id: string;
  taskInstanceId?: string;
  taskId?: string;
  goalId?: string;
  topicId?: string;
  threadId?: string;
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
  topic_id: string | null;
  thread_id: string | null;
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

function normalizeBlocker(blocker: ExecutionBlocker | null): ExecutionBlocker | null {
  if (!blocker) return blocker;
  return {
    ...blocker,
    taskId: normalizeTaskId(blocker.taskId),
    instanceId: normalizeInstanceId(blocker.instanceId),
  };
}

function normalizeRuntimeJobPayload(payload: RuntimeJobPayload): RuntimeJobPayload {
  const goal = migrateGoalIds(payload.goal);
  const subGoalId = normalizeSubGoalId(payload.subGoal.id);
  const taskId = normalizeTaskId(payload.task.id);
  const instanceId = normalizeInstanceId(payload.instance.id);
  const subGoal =
    goal.subGoals.find((item) => item.id === subGoalId) ?? {
      ...payload.subGoal,
      id: subGoalId,
      goalId: goal.id,
      tasks: payload.subGoal.tasks.map((task) => migrateTaskIds(task)),
    };
  const task = subGoal.tasks.find((item) => item.id === taskId) ?? migrateTaskIds(payload.task);
  const instance =
    task.instances.find((item) => item.id === instanceId) ??
    migrateTaskInstanceIds(payload.instance, task.id);

  return {
    ...payload,
    goal,
    subGoal,
    task,
    instance,
  };
}

function mapRow(row: RuntimeJobRow): RuntimeJobRecord {
  const payload = normalizeRuntimeJobPayload(JSON.parse(row.payload_json) as RuntimeJobPayload);
  const blocker = normalizeBlocker(parseNullableJson<ExecutionBlocker>(row.blocker_json));
  return {
    id: row.id,
    taskInstanceId: row.task_instance_id ? normalizeInstanceId(row.task_instance_id) : payload.instance.id,
    taskId: row.task_id ? normalizeTaskId(row.task_id) : payload.task.id,
    goalId: row.goal_id ? migrateGoalIds({ ...payload.goal, id: row.goal_id }).id : payload.goal.id,
    topicId: row.topic_id ? normalizeGoalId(row.topic_id) : payload.goal.id,
    threadId: row.thread_id ? normalizeSubGoalId(row.thread_id) : payload.subGoal.id,
    conversationId: row.conversation_id ?? undefined,
    userId: row.user_id,
    kind: row.kind,
    status: row.status,
    requestId: row.request_id ?? undefined,
    runtimeEnvId: row.runtime_env_id ?? undefined,
    runtimeTransport: row.runtime_transport,
    payload,
    progress: parseNullableJson<GoalServerProgress>(row.progress_json),
    logs: parseNullableJson<GoalServerLogEntry[]>(row.logs_json) ?? [],
    trajectory: parseNullableJson<ExecutionTrajectoryStep[]>(row.trajectory_json) ?? [],
    blocker,
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
  // 不再静默吞错：事件溯源日志失败若被无声丢弃，会导致 inbox/监控投影与实际状态永久分叉。
  // 由调用方在事务内调用本函数，抛出后整笔（job + event）一起回滚。
  return appendGoalEventOnce(input);
}

export function upsertRuntimeJob(record: RuntimeJobRecord) {
  const db = getDatabase();
  db.prepare(
    `
      INSERT INTO runtime_jobs (
        id, task_instance_id, task_id, goal_id, topic_id, thread_id, conversation_id, user_id, kind, status,
        request_id, runtime_env_id, runtime_transport, payload_json, progress_json, logs_json,
        trajectory_json, blocker_json, result_json, lease_owner, lease_expires_at, available_at, created_at, updated_at,
        started_at, finished_at, last_error
      ) VALUES (
        @id, @task_instance_id, @task_id, @goal_id, @topic_id, @thread_id, @conversation_id, @user_id, @kind, @status,
        @request_id, @runtime_env_id, @runtime_transport, @payload_json, @progress_json, @logs_json,
        @trajectory_json, @blocker_json, @result_json, @lease_owner, @lease_expires_at, @available_at, @created_at, @updated_at,
        @started_at, @finished_at, @last_error
      )
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        topic_id = excluded.topic_id,
        thread_id = excluded.thread_id,
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
    topic_id: record.topicId ?? record.payload.goal.id,
    thread_id: record.threadId ?? record.payload.subGoal.id,
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

/**
 * 更新除 payload_json 外的全部可变列。
 *
 * 高频进度/轨迹/续租路径不会改动 payload（整棵 Goal 树），却经由 upsertRuntimeJob 每次都
 * JSON.stringify 整个 payload 并重写大列，造成显著写放大。此函数走纯 UPDATE，既不序列化也不
 * 触碰 payload_json，仅在 payload 确实未变化时使用。
 */
function updateRuntimeJobMutableColumns(record: RuntimeJobRecord) {
  const db = getDatabase();
  db.prepare(
    `
      UPDATE runtime_jobs SET
        status = @status,
        topic_id = @topic_id,
        thread_id = @thread_id,
        request_id = @request_id,
        runtime_env_id = @runtime_env_id,
        runtime_transport = @runtime_transport,
        progress_json = @progress_json,
        logs_json = @logs_json,
        trajectory_json = @trajectory_json,
        blocker_json = @blocker_json,
        result_json = @result_json,
        lease_owner = @lease_owner,
        lease_expires_at = @lease_expires_at,
        available_at = @available_at,
        updated_at = @updated_at,
        started_at = @started_at,
        finished_at = @finished_at,
        last_error = @last_error
      WHERE id = @id
    `,
  ).run({
    id: record.id,
    status: record.status,
    topic_id: record.topicId ?? record.payload.goal.id,
    thread_id: record.threadId ?? record.payload.subGoal.id,
    request_id: record.requestId ?? null,
    runtime_env_id: record.runtimeEnvId ?? null,
    runtime_transport: record.runtimeTransport,
    progress_json: record.progress ? JSON.stringify(record.progress) : null,
    logs_json: JSON.stringify(record.logs),
    trajectory_json: JSON.stringify(record.trajectory),
    blocker_json: record.blocker ? JSON.stringify(record.blocker) : null,
    result_json: record.result ? JSON.stringify(record.result) : null,
    lease_owner: record.leaseOwner ?? null,
    lease_expires_at: record.leaseExpiresAt ?? null,
    available_at: record.availableAt ?? null,
    updated_at: record.updatedAt,
    started_at: record.startedAt ?? null,
    finished_at: record.finishedAt ?? null,
    last_error: record.lastError ?? null,
  });
}

export function createQueuedRuntimeJobInternal(
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
    topicId: payload.goal.id,
    threadId: payload.subGoal.id,
    conversationId: payload.goal.conversationId,
    userId: resolveCurrentUserId(),
    kind: "goal_task",
    status: "queued",
    requestId: input?.requestId,
    runtimeEnvId: payload.runtimeEnv.id,
    runtimeTransport: isCloudOrchestratorMode() ? "cloud_control_plane" : "local_daemon",
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
  // job 写入与事件 append 必须原子：避免 job 已落库但事件丢失导致溯源/投影分叉。
  const db = getDatabase();
  db.transaction(() => {
    upsertRuntimeJob(record);
    appendRuntimeJobGoalEvent({
      goalId: payload.goal.id,
      taskId: payload.task.id,
      instanceId: payload.instance.id,
      kind: "instance.created",
      producedBy: input?.eventSource === "scheduler" || !input?.eventSource ? "scheduler" : "user",
      idempotencyKey: createIdempotencyKey("instance.created", payload.instance.id),
      createdAt: now,
      payload: {
        requestId: input?.requestId,
        status: payload.instance.status,
        runtimeEnvId: payload.runtimeEnv.id,
        source: input?.eventSource ?? "scheduler",
      },
    });
  })();
  return record;
}

/** 监控面板用的运行时 job 实时状态行（执行引擎的权威状态，可能比 goals 快照更新）。 */
export type RuntimeJobActivityRow = {
  jobId: string;
  taskInstanceId: string;
  taskId: string | null;
  goalId: string | null;
  status: RuntimeJobStatus;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
};

/**
 * 列出仍处于活动态（queued/running/awaiting_user）的 goal_task job 实时状态。
 *
 * 用于在监控面板中校正 goals 快照滞后的问题：当 job 已被 worker 领走并在执行（running），
 * 但 goals 快照尚未回写时，面板据此把对应实例归入「执行中」。
 */
export function listOpenRuntimeJobActivity(): RuntimeJobActivityRow[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `
        SELECT id, task_instance_id, task_id, goal_id, status, started_at, finished_at, updated_at
        FROM runtime_jobs
        WHERE kind = 'goal_task'
          AND status IN ('queued', 'running', 'awaiting_user')
          AND task_instance_id IS NOT NULL
        ORDER BY updated_at DESC
      `,
    )
    .all() as Array<{
    id: string;
    task_instance_id: string;
    task_id: string | null;
    goal_id: string | null;
    status: RuntimeJobStatus;
    started_at: string | null;
    finished_at: string | null;
    updated_at: string;
  }>;
  return rows.map((row) => ({
    jobId: row.id,
    taskInstanceId: normalizeInstanceId(row.task_instance_id),
    taskId: row.task_id ? normalizeTaskId(row.task_id) : null,
    goalId: row.goal_id ? normalizeGoalId(row.goal_id) : null,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at,
  }));
}

export function listRuntimeJobsByStatuses(input: {
  statuses: RuntimeJobStatus[];
  limit?: number;
}) {
  if (input.statuses.length === 0) return [];
  const db = getDatabase();
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 1000);
  const placeholders = input.statuses.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `
        SELECT * FROM runtime_jobs
        WHERE kind = 'goal_task'
          AND status IN (${placeholders})
          AND task_instance_id IS NOT NULL
        ORDER BY updated_at DESC
        LIMIT ?
      `,
    )
    .all(...input.statuses, limit) as RuntimeJobRow[];
  return rows.map((row) => mapRow(row));
}

export function listRuntimeJobsByInstanceIds(instanceIds: string[]) {
  const uniqueIds = Array.from(new Set(instanceIds.filter(Boolean).map((id) => normalizeInstanceId(id))));
  if (uniqueIds.length === 0) return [];
  const db = getDatabase();
  const placeholders = uniqueIds.map(() => "?").join(", ");
  const directRows = db
    .prepare(
      `
        SELECT * FROM runtime_jobs
        WHERE kind = 'goal_task'
          AND task_instance_id IN (${placeholders})
        ORDER BY updated_at DESC
      `,
    )
    .all(...uniqueIds) as RuntimeJobRow[];
  const byInstanceId = new Map<string, RuntimeJobRecord>();
  for (const row of directRows) {
    const job = mapRow(row);
    const instanceId = job.taskInstanceId ? normalizeInstanceId(job.taskInstanceId) : undefined;
    if (instanceId && !byInstanceId.has(instanceId)) byInstanceId.set(instanceId, job);
  }
  const missingIds = uniqueIds.filter((id) => !byInstanceId.has(id));
  if (missingIds.length === 0) return Array.from(byInstanceId.values());

  // Legacy rows may contain pre-normalized ids inside payload only.
  const fallbackRows = db.prepare(`SELECT * FROM runtime_jobs WHERE kind = 'goal_task' ORDER BY updated_at DESC`).all() as RuntimeJobRow[];
  const missing = new Set(missingIds);
  for (const row of fallbackRows) {
    const job = mapRow(row);
    const instanceId = job.taskInstanceId ? normalizeInstanceId(job.taskInstanceId) : undefined;
    if (!instanceId || !missing.has(instanceId) || byInstanceId.has(instanceId)) continue;
    byInstanceId.set(instanceId, job);
    missing.delete(instanceId);
    if (missing.size === 0) break;
  }
  return Array.from(byInstanceId.values());
}

export function listOpenRuntimeJobsByTaskIds(taskIds: string[]) {
  const uniqueIds = Array.from(new Set(taskIds.filter(Boolean).map((id) => normalizeTaskId(id))));
  if (uniqueIds.length === 0) return [];
  const db = getDatabase();
  const placeholders = uniqueIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `
        SELECT * FROM runtime_jobs
        WHERE kind = 'goal_task'
          AND status IN ('queued', 'running', 'awaiting_user')
          AND task_id IN (${placeholders})
        ORDER BY updated_at DESC
      `,
    )
    .all(...uniqueIds) as RuntimeJobRow[];
  const byTaskId = new Map<string, RuntimeJobRecord>();
  for (const row of rows) {
    const job = mapRow(row);
    const taskId = job.taskId ? normalizeTaskId(job.taskId) : undefined;
    if (taskId && !byTaskId.has(taskId)) byTaskId.set(taskId, job);
  }
  return Array.from(byTaskId.values());
}

export function getRuntimeJobByTaskInstanceId(taskInstanceId: string) {
  const db = getDatabase();
  const row = db
    .prepare(`SELECT * FROM runtime_jobs WHERE task_instance_id = ? ORDER BY updated_at DESC LIMIT 1`)
    .get(taskInstanceId) as RuntimeJobRow | undefined;
  if (row) return mapRow(row);

  const normalizedTaskInstanceId = normalizeInstanceId(taskInstanceId);
  const fallbackRow = db
    .prepare(`SELECT * FROM runtime_jobs ORDER BY updated_at DESC`)
    .all()
    .find((candidate) => {
      const job = mapRow(candidate as RuntimeJobRow);
      return job.taskInstanceId && normalizeInstanceId(job.taskInstanceId) === normalizedTaskInstanceId;
    }) as RuntimeJobRow | undefined;
  return fallbackRow ? mapRow(fallbackRow) : null;
}

export function getLatestOpenRuntimeJobByTaskId(taskId: string) {
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT * FROM runtime_jobs
       WHERE task_id = ?
         AND status IN ('queued', 'running', 'awaiting_user')
       ORDER BY updated_at DESC
       LIMIT 1`,
    )
    .get(taskId) as RuntimeJobRow | undefined;
  if (row) return mapRow(row);

  const normalizedTaskId = normalizeTaskId(taskId);
  const fallbackRow = db
    .prepare(
      `SELECT * FROM runtime_jobs
       WHERE status IN ('queued', 'running', 'awaiting_user')
       ORDER BY updated_at DESC`,
    )
    .all()
    .find((candidate) => {
      const job = mapRow(candidate as RuntimeJobRow);
      return job.taskId && normalizeTaskId(job.taskId) === normalizedTaskId;
    }) as RuntimeJobRow | undefined;
  return fallbackRow ? mapRow(fallbackRow) : null;
}

export function getRuntimeJobByRequestId(requestId: string) {
  const db = getDatabase();
  const row = db
    .prepare(`SELECT * FROM runtime_jobs WHERE request_id = ? ORDER BY updated_at DESC LIMIT 1`)
    .get(requestId) as RuntimeJobRow | undefined;
  return row ? mapRow(row) : null;
}

export function claimQueuedRuntimeJobs(input: {
  leaseOwner: string;
  limit: number;
  leaseMs?: number;
  runtimeTransport?: RuntimeJobRecord["runtimeTransport"];
}) {
  const db = getDatabase();
  const leaseExpiresAt = new Date(Date.now() + (input.leaseMs ?? 2 * 60 * 1000)).toISOString();
  const now = nowIso();
  // SELECT 候选行 + 逐行 CAS UPDATE 包进单事务：消除 select 与 update 之间的 TOCTOU 窗口，
  // 同时把 N 次写收敛到一笔事务，降低锁竞争。
  const claim = db.transaction(() => {
    const rows = input.runtimeTransport
      ? (db
          .prepare(
            `
              SELECT * FROM runtime_jobs
              WHERE status = 'queued'
                AND runtime_transport = ?
                AND (available_at IS NULL OR available_at <= ?)
              ORDER BY created_at ASC
              LIMIT ?
            `,
          )
          .all(input.runtimeTransport, now, input.limit) as RuntimeJobRow[])
      : (db
          .prepare(
            `
              SELECT * FROM runtime_jobs
              WHERE status = 'queued'
                AND (available_at IS NULL OR available_at <= ?)
              ORDER BY created_at ASC
              LIMIT ?
            `,
          )
          .all(now, input.limit) as RuntimeJobRow[]);
    const update = db.prepare(
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
    );
    return rows.flatMap((row) => {
      const result = update.run(input.leaseOwner, leaseExpiresAt, now, now, row.id);
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
  });
  return claim();
}

export function updateRuntimeJobExecutionInternal(
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
  // job 写入与状态/进展事件 append 必须原子：避免 job 已更新但事件丢失导致投影分叉。
  const db = getDatabase();
  // payload（整棵 Goal 树）未变化时走纯列更新，跳过 payload_json 的全量序列化重写，缓解高频
  // 进度/轨迹/续租更新的写放大；payload 变化时才回退到完整 upsert。
  const payloadChanged = updates.payload !== undefined;
  db.transaction(() => {
    if (payloadChanged) {
      upsertRuntimeJob(next);
    } else {
      updateRuntimeJobMutableColumns(next);
    }
    if (updates.status && updates.status !== existing.status && next.goalId && next.taskId && next.taskInstanceId) {
      appendRuntimeJobGoalEvent({
        goalId: next.goalId,
        taskId: next.taskId,
        instanceId: next.taskInstanceId,
        kind: "job.status_changed",
        producedBy: "worker",
        idempotencyKey: createIdempotencyKey("job.status_changed.worker", next.taskInstanceId, existing.status, updates.status, next.updatedAt),
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
        idempotencyKey: createIdempotencyKey("instance.progress", next.taskInstanceId, next.updatedAt),
        createdAt: next.updatedAt,
        payload: {
          requestId: next.requestId,
          message: updates.progress.message,
          progress: updates.progress,
          trajectoryLength: updates.trajectory?.length ?? next.trajectory.length,
        },
      });
    }
  })();
  return next;
}

export function markRuntimeJobAwaiting(jobId: string, input: { reason: string; blocker?: unknown }) {
  const existing = getRuntimeJob(jobId);
  if (!existing) return null;
  return updateRuntimeJobExecutionInternal(jobId, {
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
  const expiredRows = db
    .prepare(
      `
        SELECT * FROM runtime_jobs
        WHERE lease_expires_at IS NOT NULL
          AND lease_expires_at <= ?
          AND status IN ('running')
      `,
    )
    .all(now) as RuntimeJobRow[];
  const release = db.prepare(
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
        AND id = ?
    `,
  );
  return expiredRows.flatMap((row) => {
    const result = release.run(now, now, row.id);
    if (result.changes === 0) return [];
    return mapRow({
      ...row,
      status: "queued",
      lease_owner: null,
      lease_expires_at: null,
      updated_at: now,
    });
  });
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

export function cancelRuntimeJobByTaskRun(input: { requestId?: string; taskInstanceId?: string; reason?: string }) {
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
  const fallbackRow =
    row || !input.taskInstanceId
      ? row
      : (db
          .prepare(
            `SELECT * FROM runtime_jobs
             WHERE status IN ('queued', 'running', 'awaiting_user')
             ORDER BY updated_at DESC`,
          )
          .all()
          .find((candidate) => {
            const job = mapRow(candidate as RuntimeJobRow);
            return job.taskInstanceId && normalizeInstanceId(job.taskInstanceId) === normalizeInstanceId(input.taskInstanceId!);
          }) as RuntimeJobRow | undefined);
  if (!fallbackRow) return null;
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
  ).run(now, now, input.reason ?? "用户手动停止任务执行", fallbackRow.id);
  return getRuntimeJob(fallbackRow.id);
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

import { createIdempotencyKey, createOpaqueId, normalizeGoalId, normalizeSubGoalId } from "@/lib/opaqueIds";
import { getDatabase } from "@/lib/server/db/client";

export type GovernanceTickJobStatus =
  | "queued"
  | "leased"
  | "completed"
  | "failed"
  | "expired";

export type GovernanceTickTargetKind = "topic" | "thread";

export type GovernanceTickJobPayload = {
  targetKind: GovernanceTickTargetKind;
  topicId: string;
  threadId?: string;
  baseRevision: number;
  snapshot: Record<string, unknown>;
  dueReason?: string;
  scheduledAt?: string;
};

export type GovernanceTickJobRecord<TPayload extends GovernanceTickJobPayload = GovernanceTickJobPayload> = {
  id: string;
  targetKind: GovernanceTickTargetKind;
  topicId: string;
  threadId?: string;
  userId: string;
  status: GovernanceTickJobStatus;
  baseRevision: number;
  requestId?: string;
  machineId?: string;
  payload: TPayload;
  outcome?: Record<string, unknown>;
  leaseOwner?: string;
  leaseToken?: string;
  leaseExpiresAt?: string;
  availableAt: string;
  attemptCount: number;
  idempotencyKey?: string;
  createdAt: string;
  updatedAt: string;
  leasedAt?: string;
  finishedAt?: string;
  lastError?: string;
};

export type CreateGovernanceTickJobInput<TPayload extends GovernanceTickJobPayload = GovernanceTickJobPayload> = {
  id?: string;
  targetKind: GovernanceTickTargetKind;
  topicId: string;
  threadId?: string;
  userId?: string;
  baseRevision: number;
  payload: TPayload;
  idempotencyKey?: string;
  requestId?: string;
  machineId?: string;
  availableAt?: string;
  createdAt?: string;
};

type GovernanceTickJobRow = {
  id: string;
  target_kind: GovernanceTickTargetKind;
  topic_id: string;
  thread_id: string | null;
  user_id: string;
  status: GovernanceTickJobStatus;
  base_revision: number;
  request_id: string | null;
  machine_id: string | null;
  payload_json: string;
  outcome_json: string | null;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  available_at: string;
  attempt_count: number;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
  leased_at: string | null;
  finished_at: string | null;
  last_error: string | null;
};

function nowIso() {
  return new Date().toISOString();
}

function logGovernanceLease(message: string, fields: Record<string, unknown>) {
  console.info("[governance_tick_lease]", message, fields);
}

function mapRow<TPayload extends GovernanceTickJobPayload = GovernanceTickJobPayload>(
  row: GovernanceTickJobRow,
): GovernanceTickJobRecord<TPayload> {
  return {
    id: row.id,
    targetKind: row.target_kind,
    topicId: normalizeGoalId(row.topic_id),
    threadId: row.thread_id ? normalizeSubGoalId(row.thread_id) : undefined,
    userId: row.user_id,
    status: row.status,
    baseRevision: row.base_revision,
    requestId: row.request_id ?? undefined,
    machineId: row.machine_id ?? undefined,
    payload: JSON.parse(row.payload_json) as TPayload,
    outcome: row.outcome_json ? JSON.parse(row.outcome_json) as Record<string, unknown> : undefined,
    leaseOwner: row.lease_owner ?? undefined,
    leaseToken: row.lease_token ?? undefined,
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    availableAt: row.available_at,
    attemptCount: row.attempt_count,
    idempotencyKey: row.idempotency_key ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    leasedAt: row.leased_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    lastError: row.last_error ?? undefined,
  };
}

function getById(id: string) {
  const row = getDatabase()
    .prepare(`SELECT * FROM governance_tick_jobs WHERE id = ? LIMIT 1`)
    .get(id) as GovernanceTickJobRow | undefined;
  return row ? mapRow(row) : null;
}

export function getGovernanceTickJob(id: string) {
  return getById(id);
}

export function getGovernanceTickJobByIdempotencyKey(idempotencyKey: string) {
  const row = getDatabase()
    .prepare(`SELECT * FROM governance_tick_jobs WHERE idempotency_key = ? LIMIT 1`)
    .get(idempotencyKey) as GovernanceTickJobRow | undefined;
  return row ? mapRow(row) : null;
}

export function createGovernanceTickJob<TPayload extends GovernanceTickJobPayload = GovernanceTickJobPayload>(
  input: CreateGovernanceTickJobInput<TPayload>,
): GovernanceTickJobRecord<TPayload> {
  const db = getDatabase();
  const createdAt = input.createdAt ?? nowIso();
  const topicId = normalizeGoalId(input.topicId);
  const threadId = input.threadId ? normalizeSubGoalId(input.threadId) : undefined;
  const idempotencyKey =
    input.idempotencyKey ??
    createIdempotencyKey("governance_tick_job", input.targetKind, topicId, threadId, String(input.baseRevision));
  const id = input.id ?? createOpaqueId("idem");

  const insertResult = db.prepare(
    `
      INSERT OR IGNORE INTO governance_tick_jobs (
        id, target_kind, topic_id, thread_id, user_id, status, base_revision,
        request_id, machine_id, payload_json, available_at, attempt_count,
        idempotency_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, 0, ?, ?, ?)
    `,
  ).run(
    id,
    input.targetKind,
    topicId,
    threadId ?? null,
    input.userId ?? "local-user",
    input.baseRevision,
    input.requestId ?? null,
    input.machineId ?? null,
    JSON.stringify({ ...input.payload, topicId, threadId, baseRevision: input.baseRevision }),
    input.availableAt ?? createdAt,
    idempotencyKey,
    createdAt,
    createdAt,
  );

  if (insertResult.changes === 0) {
    const existing = getGovernanceTickJobByIdempotencyKey(idempotencyKey);
    if (existing?.status === "failed") {
      const availableAt = input.availableAt ?? createdAt;
      db.prepare(
        `
          UPDATE governance_tick_jobs
          SET status = 'queued',
              request_id = ?,
              machine_id = ?,
              payload_json = ?,
              outcome_json = NULL,
              lease_owner = NULL,
              lease_token = NULL,
              lease_expires_at = NULL,
              available_at = ?,
              updated_at = ?,
              leased_at = NULL,
              finished_at = NULL,
              last_error = NULL
          WHERE id = ?
            AND status = 'failed'
        `,
      ).run(
        input.requestId ?? null,
        input.machineId ?? null,
        JSON.stringify({ ...input.payload, topicId, threadId, baseRevision: input.baseRevision }),
        availableAt,
        createdAt,
        existing.id,
      );
    }
  }

  const record = getGovernanceTickJobByIdempotencyKey(idempotencyKey) ?? getById(id);
  if (!record) throw new Error("governance tick job append failed");
  return record as GovernanceTickJobRecord<TPayload>;
}

export function expireGovernanceTickJobLeases(input: { now?: Date; expiredLeaseGraceMs?: number } = {}) {
  const nowDate = input.now ?? new Date();
  const now = nowDate.toISOString();
  const expireBefore = new Date(nowDate.getTime() - Math.max(0, input.expiredLeaseGraceMs ?? 0)).toISOString();
  const result = getDatabase()
    .prepare(
      `
        UPDATE governance_tick_jobs
        SET status = 'expired',
            updated_at = ?,
            last_error = COALESCE(last_error, 'lease_expired')
        WHERE status = 'leased'
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= ?
      `,
    )
    .run(now, expireBefore);
  if (result.changes > 0) {
    logGovernanceLease("expired stale leases", {
      count: result.changes,
      now,
      expireBefore,
      expiredLeaseGraceMs: input.expiredLeaseGraceMs ?? 0,
    });
  }
  return result.changes;
}

export function acquireGovernanceTickJobLease(input: {
  leaseOwner: string;
  leaseDurationMs: number;
  now?: Date;
  targetKind?: GovernanceTickTargetKind;
  expiredLeaseGraceMs?: number;
}): GovernanceTickJobRecord | null {
  const db = getDatabase();
  const nowDate = input.now ?? new Date();
  const now = nowDate.toISOString();
  const leaseExpiresAt = new Date(nowDate.getTime() + input.leaseDurationMs).toISOString();
  const leaseToken = createOpaqueId("idem");

  return db.transaction(() => {
    expireGovernanceTickJobLeases({ now: nowDate, expiredLeaseGraceMs: input.expiredLeaseGraceMs });
    const params: Array<string | number> = [now];
    const kindFilter = input.targetKind ? "AND target_kind = ?" : "";
    if (input.targetKind) params.push(input.targetKind);
    const row = db
      .prepare(
        `
          SELECT * FROM governance_tick_jobs
          WHERE status IN ('queued', 'expired')
            AND available_at <= ?
            ${kindFilter}
          ORDER BY available_at ASC, updated_at ASC, id ASC
          LIMIT 1
        `,
      )
      .get(...params) as GovernanceTickJobRow | undefined;
    if (!row) return null;

    const updated = db
      .prepare(
        `
          UPDATE governance_tick_jobs
          SET status = 'leased',
              lease_owner = ?,
              lease_token = ?,
              lease_expires_at = ?,
              leased_at = ?,
              updated_at = ?,
              attempt_count = attempt_count + 1,
              last_error = NULL
          WHERE id = ?
            AND status IN ('queued', 'expired')
        `,
      )
      .run(input.leaseOwner, leaseToken, leaseExpiresAt, now, now, row.id);
    if (updated.changes !== 1) return null;
    const leased = getById(row.id);
    if (leased) {
      logGovernanceLease("acquired lease", {
        jobId: leased.id,
        targetKind: leased.targetKind,
        topicId: leased.topicId,
        threadId: leased.threadId,
        leaseOwner: input.leaseOwner,
        leaseExpiresAt,
        attemptCount: leased.attemptCount,
        previousStatus: row.status,
      });
    }
    return leased;
  })();
}

export function completeGovernanceTickJob(input: {
  jobId: string;
  leaseOwner: string;
  leaseToken: string;
  outcome: Record<string, unknown>;
  finishedAt?: string;
  acceptLeaseTokenMismatch?: boolean;
}) {
  const finishedAt = input.finishedAt ?? nowIso();
  const leaseFilter = input.acceptLeaseTokenMismatch ? "" : "AND lease_token = ?";
  const params = [
    JSON.stringify(input.outcome),
    finishedAt,
    finishedAt,
    input.jobId,
    input.leaseOwner,
    ...(input.acceptLeaseTokenMismatch ? [] : [input.leaseToken]),
  ];
  const result = getDatabase()
    .prepare(
      `
        UPDATE governance_tick_jobs
        SET status = 'completed',
            outcome_json = ?,
            finished_at = ?,
            updated_at = ?,
            last_error = NULL
        WHERE id = ?
          AND status IN ('leased', 'expired')
          AND lease_owner = ?
          ${leaseFilter}
      `,
    )
    .run(...params);
  if (result.changes === 1) {
    logGovernanceLease("completed job", {
      jobId: input.jobId,
      leaseOwner: input.leaseOwner,
      acceptLeaseTokenMismatch: input.acceptLeaseTokenMismatch === true,
      finishedAt,
    });
  }
  return result.changes === 1 ? getById(input.jobId) : null;
}

export function failGovernanceTickJob(input: {
  jobId: string;
  leaseOwner?: string;
  leaseToken?: string;
  error: string;
  outcome?: Record<string, unknown>;
  failedAt?: string;
  acceptLeaseTokenMismatch?: boolean;
}) {
  const failedAt = input.failedAt ?? nowIso();
  const leaseFilter = input.leaseOwner
    ? input.acceptLeaseTokenMismatch
      ? "AND lease_owner = ?"
      : input.leaseToken
        ? "AND lease_owner = ? AND lease_token = ?"
        : "AND lease_owner = ?"
    : "";
  const params = [
    input.outcome ? JSON.stringify(input.outcome) : null,
    input.error,
    failedAt,
    failedAt,
    input.jobId,
    ...(input.leaseOwner
      ? input.acceptLeaseTokenMismatch
        ? [input.leaseOwner]
        : input.leaseToken
          ? [input.leaseOwner, input.leaseToken]
          : [input.leaseOwner]
      : []),
  ];
  const result = getDatabase()
    .prepare(
      `
        UPDATE governance_tick_jobs
        SET status = 'failed',
            outcome_json = COALESCE(?, outcome_json),
            last_error = ?,
            finished_at = ?,
            updated_at = ?
        WHERE id = ?
          AND status IN ('leased', 'expired')
          ${leaseFilter}
      `,
    )
    .run(...params);
  if (result.changes === 1) {
    logGovernanceLease("failed job", {
      jobId: input.jobId,
      leaseOwner: input.leaseOwner,
      error: input.error,
      acceptLeaseTokenMismatch: input.acceptLeaseTokenMismatch === true,
      failedAt,
    });
  }
  return result.changes === 1 ? getById(input.jobId) : null;
}

export function countPendingGovernanceTickJobs(input: { now?: Date; expiredLeaseGraceMs?: number } = {}) {
  const nowDate = input.now ?? new Date();
  const now = nowDate.toISOString();
  const expireBefore = new Date(nowDate.getTime() - Math.max(0, input.expiredLeaseGraceMs ?? 0)).toISOString();
  const row = getDatabase()
    .prepare(
      `
        SELECT COUNT(*) AS count
        FROM governance_tick_jobs
        WHERE (
            status IN ('queued', 'expired')
            AND available_at <= ?
          )
          OR (
            status = 'leased'
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at <= ?
          )
      `,
    )
    .get(now, expireBefore) as { count: number } | undefined;
  return row?.count ?? 0;
}

export function renewGovernanceTickJobLeaseFromHello(input: {
  jobId: string;
  userId: string;
  machineId: string;
  leaseDurationMs: number;
  now?: Date;
}) {
  const nowDate = input.now ?? new Date();
  const now = nowDate.toISOString();
  const leaseExpiresAt = new Date(nowDate.getTime() + input.leaseDurationMs).toISOString();
  const result = getDatabase()
    .prepare(
      `
        UPDATE governance_tick_jobs
        SET status = 'leased',
            machine_id = ?,
            lease_expires_at = ?,
            updated_at = ?,
            last_error = NULL
        WHERE id = ?
          AND user_id = ?
          AND status IN ('leased', 'expired')
          AND lease_owner IS NOT NULL
          AND lease_token IS NOT NULL
      `,
    )
    .run(input.machineId, leaseExpiresAt, now, input.jobId, input.userId);
  const renewed = result.changes === 1 ? getById(input.jobId) : null;
  if (renewed) {
    logGovernanceLease("renewed running job lease", {
      jobId: input.jobId,
      userId: input.userId,
      machineId: input.machineId,
      leaseExpiresAt,
      status: renewed.status,
      attemptCount: renewed.attemptCount,
    });
  }
  return renewed;
}

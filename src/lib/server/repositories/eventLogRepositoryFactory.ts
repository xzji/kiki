import { randomUUID } from "crypto";

import { getDatabase } from "@/lib/server/db/client";

/**
 * goal_event_log 与 conversation_event_log 两套事件日志仓库高度同构：建表外的 append（INSERT
 * ON CONFLICT + 回读）、按幂等键查询、appendOnce（check-then-insert 事务）逻辑逐行对应，仅在
 * 表名 / event_id 前缀 / owner 列（及其规范化）/ mapRow 上有差异。此工厂收敛这部分公共实现，
 * 各仓库只注入差异并保留自身的查询函数与对外泛型签名。
 */

export type EventLogInputBase = {
  eventId?: string;
  kind: string;
  payload: unknown;
  producedBy: string;
  idempotencyKey?: string;
  createdAt?: string;
};

export type EventLogRowBase = {
  event_id: string;
  idempotency_key: string | null;
};

export type EventLogRepositoryConfig<Row extends EventLogRowBase, Rec, Input extends EventLogInputBase> = {
  /** 事件日志表名。仅取自内部常量，非用户输入，无注入风险。 */
  table: string;
  /** event_id 前缀（如 "goal-event" / "conversation-event"）。 */
  eventIdPrefix: string;
  /** 该表的 owner 列名，按 INSERT 顺序排列（如 ["goal_id","task_id","instance_id"]）。 */
  ownerColumns: readonly string[];
  /** 从输入抽取并规范化 owner 列的绑定值，键须与 ownerColumns 一致。 */
  toOwnerParams: (input: Input) => Record<string, string | null>;
  mapRow: (row: Row) => Rec;
};

function nowIso() {
  return new Date().toISOString();
}

export function createEventLogRepository<
  Row extends EventLogRowBase,
  Rec,
  Input extends EventLogInputBase,
>(config: EventLogRepositoryConfig<Row, Rec, Input>) {
  const { table, eventIdPrefix, ownerColumns, toOwnerParams, mapRow } = config;
  const columns = [
    "event_id",
    ...ownerColumns,
    "kind",
    "payload_json",
    "produced_by",
    "idempotency_key",
    "created_at",
  ];
  const columnList = columns.join(", ");
  const valueList = columns.map((column) => `@${column}`).join(", ");
  const insertSql = `INSERT INTO ${table} (${columnList}) VALUES (${valueList}) ON CONFLICT(event_id) DO NOTHING`;
  const insertOrIgnoreSql = `INSERT OR IGNORE INTO ${table} (${columnList}) VALUES (${valueList})`;
  const selectByEventIdSql = `SELECT * FROM ${table} WHERE event_id = ? LIMIT 1`;
  const selectByIdempotencyKeySql = `SELECT * FROM ${table} WHERE idempotency_key = ? LIMIT 1`;

  function createEventId() {
    return `${eventIdPrefix}-${randomUUID()}`;
  }

  function buildParams(input: Input, eventId: string, createdAt: string) {
    return {
      event_id: eventId,
      ...toOwnerParams(input),
      kind: input.kind,
      payload_json: JSON.stringify(input.payload),
      produced_by: input.producedBy,
      idempotency_key: input.idempotencyKey ?? null,
      created_at: createdAt,
    };
  }

  function getByIdempotencyKey(idempotencyKey: string): Rec | null {
    const row = getDatabase().prepare(selectByIdempotencyKeySql).get(idempotencyKey) as Row | undefined;
    return row ? mapRow(row) : null;
  }

  function append(input: Input): Rec | null {
    const db = getDatabase();
    const eventId = input.eventId ?? createEventId();
    const createdAt = input.createdAt ?? nowIso();
    db.prepare(insertSql).run(buildParams(input, eventId, createdAt));
    const row = db.prepare(selectByEventIdSql).get(eventId) as Row | undefined;
    return row ? mapRow(row) : null;
  }

  function appendOnce(input: Input): Rec | null {
    if (!input.idempotencyKey) return append(input);
    const db = getDatabase();
    const idempotencyKey = input.idempotencyKey;
    const eventId = input.eventId ?? createEventId();
    const createdAt = input.createdAt ?? nowIso();
    // check-then-insert-reload 包进事务：并发下两个调用不会都读到「不存在」后各自插入产生竞态歧义；
    // 唯一索引兜底去重，事务保证回读结果一致。嵌套在外层事务中时 better-sqlite3 自动降级为 savepoint。
    const run = db.transaction((): Rec | null => {
      const existing = getByIdempotencyKey(idempotencyKey);
      if (existing) return existing;
      db.prepare(insertOrIgnoreSql).run(buildParams(input, eventId, createdAt));
      const row = db.prepare(selectByIdempotencyKeySql).get(idempotencyKey) as Row | undefined;
      return row ? mapRow(row) : null;
    });
    return run();
  }

  return { createEventId, getByIdempotencyKey, append, appendOnce };
}

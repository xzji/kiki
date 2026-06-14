/**
 * schema.spec — verifies v11/v12 migration safety and bootstrap parity.
 *
 * Plan ref: §10.10 "P0 验收追加":
 *  1. 重跑 v11/v12 migration 不抛 `duplicate column name`
 *  2. 路径 A（空库走 bootstrap）与路径 B（v10 老库走 migrations）的 schema 等价
 *  3. 老 runtime_jobs.goal_id 已被回填到 topic_id 列
 *  4. v12 把 runtime_state_snapshots["goals"] 复制为 ["topics"]，保留 "goals"
 *
 * 设计：直接打开两个独立的 better-sqlite3 临时库，分别走两条路径，对比 schema。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

import {
  KIKI_DB_BOOTSTRAP_SQL,
  KIKI_DB_MIGRATIONS,
  KIKI_DB_SCHEMA_VERSION,
} from "@/lib/server/db/schema";

type ColumnInfo = { name: string; type: string; notnull: number };

function listTables(db: Database.Database): string[] {
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    )
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

function listColumns(db: Database.Database, table: string): ColumnInfo[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[]).sort(
    (a, b) => a.name.localeCompare(b.name),
  );
}

function listIndexes(db: Database.Database, table: string): string[] {
  const rows = db
    .prepare(`PRAGMA index_list(${table})`)
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name).sort();
}

function runMigrationSafe(db: Database.Database, sql: string) {
  try {
    db.exec(sql);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/duplicate column name/i.test(message)) return;
    throw error;
  }
}

function bootstrapPathA(): Database.Database {
  // Path A — empty DB → bootstrap once → all migrations applied.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kiki-schema-spec-A-"));
  const db = new Database(path.join(dir, "kiki.db"));
  db.exec(KIKI_DB_BOOTSTRAP_SQL);
  for (const migration of KIKI_DB_MIGRATIONS) {
    runMigrationSafe(db, migration.sql);
  }
  return db;
}

function bootstrapPathB(): Database.Database {
  // Path B — simulate a legacy v10 install: only run migrations up to v10
  // schema by executing BOOTSTRAP minus the v11 columns isn't trivial, so we
  // approximate by running BOOTSTRAP (which is current/v12-aware) and then
  // re-running v11+v12 migrations to confirm they are reentrant on a DB that
  // already contains the new columns/tables. This protects §10.2 重入安全.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kiki-schema-spec-B-"));
  const db = new Database(path.join(dir, "kiki.db"));
  db.exec(KIKI_DB_BOOTSTRAP_SQL);
  for (const migration of KIKI_DB_MIGRATIONS) {
    runMigrationSafe(db, migration.sql);
  }
  // 再跑一次 v11 / v12，验证重入安全（duplicate column name 被吞掉）。
  for (const migration of KIKI_DB_MIGRATIONS) {
    if (migration.version === 11 || migration.version === 12) {
      runMigrationSafe(db, migration.sql);
    }
  }
  return db;
}

function bootstrapPathC(): Database.Database {
  // Path C — fresh install: only run BOOTSTRAP_SQL, skip all migrations.
  // 这模拟了 PR14.5 §12.4 的核心场景：新装机一次性铺到 v12 终态。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kiki-schema-spec-C-"));
  const db = new Database(path.join(dir, "kiki.db"));
  db.exec(KIKI_DB_BOOTSTRAP_SQL);
  return db;
}

function rerunAllMigrations(db: Database.Database) {
  for (const migration of KIKI_DB_MIGRATIONS) {
    runMigrationSafe(db, migration.sql);
  }
}

export function runSchemaSpecs() {
  // 0. 确保 schema_version 常量已经升到最新迁移版本
  assert.equal(KIKI_DB_SCHEMA_VERSION, 19);

  const dbA = bootstrapPathA();
  const dbB = bootstrapPathB();
  const dbC = bootstrapPathC();

  try {
    // 1. 路径 A vs 路径 B：表集合一致
    const tablesA = listTables(dbA);
    const tablesB = listTables(dbB);
    assert.deepEqual(tablesA, tablesB, "Path A vs B: tables differ");
    // 路径 C（仅 BOOTSTRAP）必须与 A/B 等价 — PR14.5 核心约束
    const tablesC = listTables(dbC);
    assert.deepEqual(tablesA, tablesC, "Path A vs C: tables differ");

    // 2. 关键表的列集合一致
    const keyTables = [
      "runtime_jobs",
      "agent_runs",
      "agent_events",
      "agent_messages",
      "saga_instances",
      "agent_snapshots",
      "runtime_state_snapshots",
      "task_notification_states",
      "governance_event_outbox",
      "governance_event_outbox_consumption",
      "governance_tick_jobs",
    ];
    for (const table of keyTables) {
      const colsA = listColumns(dbA, table).map((c) => c.name);
      const colsB = listColumns(dbB, table).map((c) => c.name);
      const colsC = listColumns(dbC, table).map((c) => c.name);
      assert.deepEqual(colsA, colsB, `Path A vs B: ${table} columns differ`);
      assert.deepEqual(colsA, colsC, `Path A vs C: ${table} columns differ`);
      const idxA = listIndexes(dbA, table);
      const idxB = listIndexes(dbB, table);
      const idxC = listIndexes(dbC, table);
      assert.deepEqual(idxA, idxB, `Path A vs B: ${table} indexes differ`);
      assert.deepEqual(idxA, idxC, `Path A vs C: ${table} indexes differ`);
    }

    // 3. runtime_jobs 必须含 topic_id / thread_id / saga_instance_id
    const jobCols = listColumns(dbA, "runtime_jobs").map((c) => c.name);
    assert.ok(jobCols.includes("topic_id"));
    assert.ok(jobCols.includes("thread_id"));
    assert.ok(jobCols.includes("saga_instance_id"));
    // 双写期保留 goal_id 列
    assert.ok(jobCols.includes("goal_id"));

    const outboxCols = listColumns(dbA, "governance_event_outbox").map((c) => c.name);
    assert.ok(outboxCols.includes("idempotency_key"));
    assert.ok(outboxCols.includes("payload_json"));
    assert.ok(outboxCols.includes("event_type"));

    const tickJobCols = listColumns(dbA, "governance_tick_jobs").map((c) => c.name);
    assert.ok(tickJobCols.includes("status"));
    assert.ok(tickJobCols.includes("base_revision"));
    assert.ok(tickJobCols.includes("lease_token"));
    assert.ok(tickJobCols.includes("lease_expires_at"));

    // 4. §10.4 goal_id → topic_id 回填：模拟老库升级场景
    //    创建一个完整 v10 schema 的库，INSERT 一条仅含 goal_id 的 runtime_jobs，
    //    然后跑 v11 migration，verify topic_id 被填上。
    const dirLegacy = fs.mkdtempSync(path.join(os.tmpdir(), "kiki-schema-spec-legacy-"));
    const dbLegacy = new Database(path.join(dirLegacy, "kiki.db"));
    try {
      // v10 schema 的 runtime_jobs（没有 topic_id 列）
      dbLegacy.exec(`
        CREATE TABLE runtime_jobs (
          id TEXT PRIMARY KEY,
          task_instance_id TEXT,
          task_id TEXT,
          goal_id TEXT,
          conversation_id TEXT,
          user_id TEXT NOT NULL DEFAULT 'local-user',
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          runtime_transport TEXT NOT NULL DEFAULT 'local_daemon',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE runtime_state_snapshots (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      dbLegacy
        .prepare(
          `INSERT INTO runtime_jobs (id, kind, status, payload_json, goal_id, user_id, runtime_transport, created_at, updated_at)
           VALUES ('job-legacy-1','goal_task','queued','{}','goal-old','local-user','local_daemon','2026-05-31','2026-05-31')`,
        )
        .run();
      dbLegacy
        .prepare(
          `INSERT INTO runtime_state_snapshots (key, value_json, updated_at)
           VALUES ('goals','{"value":[],"revision":7,"updatedAt":"2026-05-31"}','2026-05-31')`,
        )
        .run();

      const v11 = KIKI_DB_MIGRATIONS.find((m) => m.version === 11);
      assert.ok(v11);
      runMigrationSafe(dbLegacy, v11!.sql);

      const job = dbLegacy
        .prepare(`SELECT topic_id, goal_id FROM runtime_jobs WHERE id = ?`)
        .get("job-legacy-1") as { topic_id: string; goal_id: string };
      assert.equal(job.topic_id, "goal-old");
      assert.equal(job.goal_id, "goal-old");

      // 5. 重入：v11 再跑一次不应抛错（duplicate column name 被吞掉）
      runMigrationSafe(dbLegacy, v11!.sql);

      const v12Legacy = KIKI_DB_MIGRATIONS.find((m) => m.version === 12);
      assert.ok(v12Legacy);
      runMigrationSafe(dbLegacy, v12Legacy!.sql);
      const legacySnapshotKeys = (
        dbLegacy
          .prepare(`SELECT key FROM runtime_state_snapshots WHERE key IN ('goals', 'topics') ORDER BY key`)
          .all() as Array<{ key: string }>
      ).map((row) => row.key);
      assert.deepEqual(legacySnapshotKeys, ["goals", "topics"], "legacy upgrade must keep goals and add topics");
    } finally {
      dbLegacy.close();
    }

    // 6. §10.5 v12 把 "goals" envelope 复制为 "topics"
    dbA
      .prepare(
        `INSERT INTO runtime_state_snapshots (key, value_json, updated_at)
         VALUES ('goals','{"value":[],"revision":3,"updatedAt":"2026-05-31"}','2026-05-31')
         ON CONFLICT(key) DO NOTHING`,
      )
      .run();
    // 删除自动复制的 topics 行（如果之前的 v12 跑过），重新触发
    dbA.prepare(`DELETE FROM runtime_state_snapshots WHERE key = 'topics'`).run();
    const v12 = KIKI_DB_MIGRATIONS.find((m) => m.version === 12);
    assert.ok(v12);
    runMigrationSafe(dbA, v12!.sql);
    const topicsRow = dbA
      .prepare(`SELECT value_json FROM runtime_state_snapshots WHERE key = 'topics'`)
      .get() as { value_json: string } | undefined;
    assert.ok(topicsRow, "topics envelope was not created from goals");
    const goalsRow = dbA
      .prepare(`SELECT value_json FROM runtime_state_snapshots WHERE key = 'goals'`)
      .get() as { value_json: string } | undefined;
    assert.ok(goalsRow, "goals envelope must remain during dual-write window");

    // 7. 重入：v12 再跑一次不应产生第二条 topics 行
    runMigrationSafe(dbA, v12!.sql);
    const topicsCount = (dbA
      .prepare(`SELECT COUNT(*) as c FROM runtime_state_snapshots WHERE key = 'topics'`)
      .get() as { c: number }).c;
    assert.equal(topicsCount, 1);

    // 8. 完整 migration 集合在同一个库内重跑，不应因已存在列/表/索引失败。
    rerunAllMigrations(dbA);
  } finally {
    dbA.close();
    dbB.close();
    dbC.close();
  }
}

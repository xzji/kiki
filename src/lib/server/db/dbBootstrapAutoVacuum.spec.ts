/**
 * dbBootstrapAutoVacuum.spec — verifies new SQLite DBs default to auto_vacuum=INCREMENTAL.
 *
 * 背景：每个用户独立 SQLite 库（WAL），新库应默认 INCREMENTAL(2)，
 * 使删除后的空闲页可被增量回收，避免文件只增不减浪费 Railway 存储。
 *
 * 关键约束：
 *  - auto_vacuum 必须在任何建表前设置才对新库生效。
 *  - 对已建表的旧库设置 PRAGMA 不会即时生效（需要一次完整 VACUUM 重写），
 *    我们绝不在热路径上做这件事。
 *
 * 设计：直接打开临时 better-sqlite3 库，复制 bootstrap() 的等价 pragma 顺序
 * （bootstrap 是 client.ts 内部私有函数，无法直接 import）。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

import { KIKI_DB_BOOTSTRAP_SQL } from "@/lib/server/db/schema";

export function runDbBootstrapAutoVacuumSpecs() {
  // 测试1：新库走 bootstrap 流程后 auto_vacuum 应为 INCREMENTAL(2)
  const dirNew = fs.mkdtempSync(path.join(os.tmpdir(), "kiki-autovacuum-new-"));
  const dbNew = new Database(path.join(dirNew, "kiki.db"));
  try {
    dbNew.pragma("auto_vacuum = INCREMENTAL");
    dbNew.pragma("journal_mode = WAL");
    dbNew.exec(KIKI_DB_BOOTSTRAP_SQL);
    const mode = dbNew.pragma("auto_vacuum", { simple: true });
    assert.equal(mode, 2, "new bootstrap DB must have auto_vacuum=INCREMENTAL(2)");
  } finally {
    dbNew.close();
    fs.rmSync(dirNew, { recursive: true, force: true });
  }

  // 测试2：旧库语义——已建表写入后再设置 PRAGMA 不会即时生效（仍为 0）
  const dirLegacy = fs.mkdtempSync(path.join(os.tmpdir(), "kiki-autovacuum-legacy-"));
  const dbLegacy = new Database(path.join(dirLegacy, "kiki.db"));
  try {
    dbLegacy.pragma("journal_mode = WAL");
    dbLegacy.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)`);
    dbLegacy.prepare(`INSERT INTO t (v) VALUES (?)`).run("hello");
    // 对已建表旧库设置 auto_vacuum：不应即时生效（不触发整库重写）
    dbLegacy.pragma("auto_vacuum = INCREMENTAL");
    const mode = dbLegacy.pragma("auto_vacuum", { simple: true });
    assert.equal(mode, 0, "legacy DB pragma should not take effect without full VACUUM");
  } finally {
    dbLegacy.close();
    fs.rmSync(dirLegacy, { recursive: true, force: true });
  }

  console.log("[spec] dbBootstrapAutoVacuum: new DB defaults to INCREMENTAL, legacy DB unchanged ✓");
}

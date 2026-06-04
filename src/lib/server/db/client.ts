import fs from "fs";

import Database from "better-sqlite3";

import { getDatabaseFilePath } from "@/lib/server/storage/paths";

import { KIKI_DB_BOOTSTRAP_SQL, KIKI_DB_MIGRATIONS, KIKI_DB_SCHEMA_VERSION } from "./schema";

let db: Database.Database | null = null;
let dbPath: string | null = null;
let dbInode: number | null = null;
let lastInodeCheckAt = 0;

// 低频校验间隔：getDatabase() 调用极频繁，避免每次都 stat。
const INODE_CHECK_INTERVAL_MS = 5_000;

function statInode(filePath: string): number | null {
  try {
    return fs.statSync(filePath).ino;
  } catch {
    return null;
  }
}

function getSchemaVersion(database: Database.Database) {
  const row = database.prepare(`SELECT value FROM meta WHERE key = 'schema_version' LIMIT 1`).get() as
    | { value: string }
    | undefined;
  const parsed = Number(row?.value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function hasColumn(database: Database.Database, table: string, column: string) {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function runMigration(database: Database.Database, sql: string) {
  try {
    database.exec(sql);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/duplicate column name/i.test(message)) return;
    throw error;
  }
}

function runMigrations(database: Database.Database) {
  const currentVersion = getSchemaVersion(database);
  for (const migration of KIKI_DB_MIGRATIONS) {
    if (migration.version <= currentVersion) continue;
    if (migration.version === 2 && hasColumn(database, "runtime_jobs", "trajectory_json")) continue;
    if (migration.version === 3 && hasColumn(database, "runtime_jobs", "blocker_json")) continue;
    runMigration(database, migration.sql);
  }
}

function bootstrap(database: Database.Database) {
  database.pragma("journal_mode = WAL");
  database.pragma("busy_timeout = 5000");
  database.exec(KIKI_DB_BOOTSTRAP_SQL);
  runMigrations(database);
  database
    .prepare(
      `
        INSERT INTO meta (key, value)
        VALUES ('schema_version', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `,
    )
    .run(String(KIKI_DB_SCHEMA_VERSION));
}

function openDatabase(): Database.Database {
  const filePath = getDatabaseFilePath();
  const database = new Database(filePath);
  bootstrap(database);
  db = database;
  dbPath = filePath;
  dbInode = statInode(filePath);
  lastInodeCheckAt = Date.now();
  return database;
}

export function getDatabase() {
  if (!db) {
    return openDatabase();
  }

  // inode 自检：若 getDatabaseFilePath() 指向的文件被替换/删除（inode 漂移），
  // 当前句柄会变成写不到磁盘路径的"幽灵 fd"。检测到后关闭旧句柄并重开，避免读写分裂。
  const now = Date.now();
  if (now - lastInodeCheckAt >= INODE_CHECK_INTERVAL_MS) {
    lastInodeCheckAt = now;
    const currentPath = getDatabaseFilePath();
    const currentInode = statInode(currentPath);
    const drifted =
      currentPath !== dbPath || (currentInode !== null && dbInode !== null && currentInode !== dbInode);
    if (drifted) {
      console.warn(
        `[db] database file changed (path: ${dbPath} -> ${currentPath}, inode: ${dbInode} -> ${currentInode}); reopening connection`,
      );
      try {
        db.close();
      } catch {
        // 旧句柄可能已不可用，忽略关闭异常。
      }
      db = null;
      return openDatabase();
    }
  }

  return db;
}

export function getDatabaseRuntimeInfo() {
  return { path: dbPath, inode: dbInode };
}

export function closeDatabaseForReset() {
  if (db) {
    db.close();
  }
  db = null;
  dbPath = null;
  dbInode = null;
  lastInodeCheckAt = 0;
}

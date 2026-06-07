import fs from "fs";

import Database from "better-sqlite3";

import { getCurrentUserId } from "@/lib/server/context/userContext";
import { getDatabaseFilePath } from "@/lib/server/storage/paths";

import { KIKI_DB_BOOTSTRAP_SQL, KIKI_DB_MIGRATIONS, KIKI_DB_SCHEMA_VERSION } from "./schema";

type CachedDatabase = {
  database: Database.Database;
  path: string;
  inode: number | null;
  lastInodeCheckAt: number;
  lastAccessAt: number;
};

const INODE_CHECK_INTERVAL_MS = 5_000;
const DEFAULT_CACHE_MAX = Number(process.env.KIKI_DB_CACHE_MAX ?? "32");
const DEFAULT_CACHE_IDLE_MS = Number(process.env.KIKI_DB_CACHE_IDLE_MS ?? String(10 * 60 * 1000));

const dbCache = new Map<string, CachedDatabase>();

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

function openDatabase(userId: string): CachedDatabase {
  const filePath = getDatabaseFilePath();
  fs.mkdirSync(filePath.replace(/[/\\][^/\\]+$/, ""), { recursive: true });
  const database = new Database(filePath);
  bootstrap(database);
  const entry: CachedDatabase = {
    database,
    path: filePath,
    inode: statInode(filePath),
    lastInodeCheckAt: Date.now(),
    lastAccessAt: Date.now(),
  };
  dbCache.set(userId, entry);
  evictIdleDatabases(userId);
  return entry;
}

function evictIdleDatabases(exceptUserId?: string) {
  const now = Date.now();
  for (const [userId, entry] of Array.from(dbCache.entries())) {
    if (userId === exceptUserId) continue;
    if (now - entry.lastAccessAt < DEFAULT_CACHE_IDLE_MS) continue;
    try {
      entry.database.close();
    } catch {
      // ignore
    }
    dbCache.delete(userId);
  }
  if (dbCache.size <= DEFAULT_CACHE_MAX) return;
  const sorted = Array.from(dbCache.entries())
    .filter(([userId]) => userId !== exceptUserId)
    .sort((a, b) => a[1].lastAccessAt - b[1].lastAccessAt);
  while (dbCache.size > DEFAULT_CACHE_MAX && sorted.length > 0) {
    const [userId, entry] = sorted.shift()!;
    try {
      entry.database.close();
    } catch {
      // ignore
    }
    dbCache.delete(userId);
  }
}

function reopenIfDrifted(userId: string, entry: CachedDatabase): CachedDatabase {
  const now = Date.now();
  if (now - entry.lastInodeCheckAt < INODE_CHECK_INTERVAL_MS) {
    return entry;
  }
  entry.lastInodeCheckAt = now;
  const currentPath = getDatabaseFilePath();
  const currentInode = statInode(currentPath);
  const drifted =
    currentPath !== entry.path ||
    (currentInode !== null && entry.inode !== null && currentInode !== entry.inode);
  if (!drifted) {
    return entry;
  }
  console.warn(
    `[db] database file changed for user ${userId} (path: ${entry.path} -> ${currentPath}, inode: ${entry.inode} -> ${currentInode}); reopening connection`,
  );
  try {
    entry.database.close();
  } catch {
    // ignore
  }
  dbCache.delete(userId);
  return openDatabase(userId);
}

export function getDatabase() {
  const userId = getCurrentUserId();
  let entry = dbCache.get(userId);
  if (!entry) {
    entry = openDatabase(userId);
  } else {
    entry.lastAccessAt = Date.now();
    entry = reopenIfDrifted(userId, entry);
  }
  return entry.database;
}

export function getDatabaseRuntimeInfo() {
  const userId = getCurrentUserId();
  const entry = dbCache.get(userId);
  return { path: entry?.path ?? null, inode: entry?.inode ?? null };
}

export function closeDatabaseForReset(userId?: string) {
  if (userId) {
    const entry = dbCache.get(userId);
    if (entry) {
      try {
        entry.database.close();
      } catch {
        // ignore
      }
      dbCache.delete(userId);
    }
    return;
  }
  for (const [, entry] of Array.from(dbCache.entries())) {
    try {
      entry.database.close();
    } catch {
      // ignore
    }
  }
  dbCache.clear();
}

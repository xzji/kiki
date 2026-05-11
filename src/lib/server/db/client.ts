import Database from "better-sqlite3";

import { getDatabaseFilePath } from "@/lib/server/storage/paths";

import { KIKI_DB_BOOTSTRAP_SQL, KIKI_DB_MIGRATIONS, KIKI_DB_SCHEMA_VERSION } from "./schema";

let db: Database.Database | null = null;

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

export function getDatabase() {
  if (!db) {
    db = new Database(getDatabaseFilePath());
    bootstrap(db);
  }
  return db;
}

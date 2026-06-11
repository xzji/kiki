import fs from "fs";

import Database from "better-sqlite3";

import { getRegistryDatabaseFilePath } from "@/lib/server/storage/paths";

import { seedInviteCodesFromEnv } from "@/lib/server/services/inviteCodeService";

import { REGISTRY_DB_BOOTSTRAP_SQL } from "./registrySchema";

let registryDb: Database.Database | null = null;

function bootstrap(database: Database.Database) {
  database.pragma("journal_mode = WAL");
  database.pragma("busy_timeout = 5000");
  database.exec(REGISTRY_DB_BOOTSTRAP_SQL);
  ensureInviteCodeUsageColumns(database);
  seedInviteCodesFromEnv(database);
}

function ensureInviteCodeUsageColumns(database: Database.Database) {
  const columns = database.pragma("table_info(invite_codes)") as Array<{ name: string }>;
  const columnNames = new Set(columns.map((column) => column.name));
  if (!columnNames.has("max_uses")) {
    database.exec(`ALTER TABLE invite_codes ADD COLUMN max_uses INTEGER NOT NULL DEFAULT 1`);
  }
  if (!columnNames.has("usage_count")) {
    database.exec(`ALTER TABLE invite_codes ADD COLUMN usage_count INTEGER NOT NULL DEFAULT 0`);
  }
  database.exec(`
    UPDATE invite_codes
    SET usage_count = 1
    WHERE used_at IS NOT NULL AND usage_count = 0
  `);
}

function openRegistryDatabase(): Database.Database {
  const filePath = getRegistryDatabaseFilePath();
  fs.mkdirSync(filePath.replace(/[/\\][^/\\]+$/, ""), { recursive: true });
  const database = new Database(filePath);
  bootstrap(database);
  registryDb = database;
  return database;
}

export function getRegistryDatabase() {
  if (!registryDb) {
    return openRegistryDatabase();
  }
  return registryDb;
}

export function closeRegistryDatabase() {
  if (registryDb) {
    registryDb.close();
  }
  registryDb = null;
}

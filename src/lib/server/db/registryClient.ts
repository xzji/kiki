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
  seedInviteCodesFromEnv(database);
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

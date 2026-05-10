import Database from "better-sqlite3";

import { getDatabaseFilePath } from "@/lib/server/storage/paths";

import { KIKI_DB_BOOTSTRAP_SQL, KIKI_DB_SCHEMA_VERSION } from "./schema";

let db: Database.Database | null = null;

function bootstrap(database: Database.Database) {
  database.pragma("journal_mode = WAL");
  database.pragma("busy_timeout = 5000");
  database.exec(KIKI_DB_BOOTSTRAP_SQL);
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

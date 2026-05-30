import type Database from "better-sqlite3";

import { getDatabase } from "@/lib/server/db/client";

export type DatabaseStatement = Pick<Database.Statement, "all" | "get" | "run">;

export interface DatabaseAdapter {
  prepare(sql: string): DatabaseStatement;
  exec(sql: string): void;
  transaction<T>(fn: () => T): T;
}

// CLOUD-MIGRATION: 替换实现时不应改调用方接口。
export class LocalSqliteDatabaseAdapter implements DatabaseAdapter {
  prepare(sql: string) {
    return getDatabase().prepare(sql);
  }

  exec(sql: string) {
    getDatabase().exec(sql);
  }

  transaction<T>(fn: () => T) {
    return getDatabase().transaction(fn)();
  }
}

export function getDatabaseAdapter(): DatabaseAdapter {
  return new LocalSqliteDatabaseAdapter();
}

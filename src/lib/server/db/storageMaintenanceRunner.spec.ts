import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

import { closeRegistryDatabase, getRegistryDatabase } from "@/lib/server/db/registryClient";
import {
  runStorageMaintenanceTick,
  shouldRunStorageMaintenance,
} from "./storageMaintenanceRunner";
import type { StorageMaintenanceConfig } from "./storageMaintenanceConfig";

function config(overrides: Partial<StorageMaintenanceConfig> = {}): StorageMaintenanceConfig {
  return {
    enabled: true,
    freelistRatioThreshold: 0.5,
    minReclaimableBytes: 1024,
    intervalMs: 1,
    maxDbsPerCycle: 3,
    minFreeDiskBytes: 1024,
    lowTrafficHours: { startHour: 2, endHour: 6 },
    ...overrides,
  };
}

function insertRegistryUser(userId: string, createdAt: string) {
  getRegistryDatabase()
    .prepare(
      `
        INSERT INTO users (
          id, email, password_hash, password_salt, display_name, status, created_at, updated_at
        )
        VALUES (?, ?, 'hash', 'salt', ?, 'active', ?, ?)
      `,
    )
    .run(userId, `${userId}@example.test`, userId, createdAt, createdAt);
}

function createUserDb(dataDir: string, userId: string, reclaimable: boolean) {
  const userDir = path.join(dataDir, "users", userId);
  fs.mkdirSync(userDir, { recursive: true });
  const dbPath = path.join(userDir, "kiki.db");
  const db = new Database(dbPath);
  try {
    db.pragma("auto_vacuum = INCREMENTAL");
    db.pragma("journal_mode = WAL");
    db.exec(`CREATE TABLE payloads (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)`);
    const insert = db.prepare(`INSERT INTO payloads (payload) VALUES (?)`);
    const insertMany = db.transaction(() => {
      for (let i = 0; i < 300; i += 1) {
        insert.run("x".repeat(2048));
      }
    });
    insertMany();
    if (reclaimable) {
      db.prepare(`DELETE FROM payloads WHERE id <= 250`).run();
    }
    db.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}

export function runStorageMaintenanceRunnerSpecs() {
  const inWindow = new Date("2026-06-22T03:00:00Z");
  const outsideWindow = new Date("2026-06-22T12:00:00Z");

  assert.equal(
    shouldRunStorageMaintenance(inWindow, config({ enabled: false }), 2048),
    false,
    "disabled maintenance should not run",
  );
  assert.equal(
    shouldRunStorageMaintenance(outsideWindow, config(), 2048),
    false,
    "maintenance should not run outside low-traffic hours",
  );
  assert.equal(
    shouldRunStorageMaintenance(inWindow, config({ minFreeDiskBytes: 2048 }), 1024),
    false,
    "maintenance should not run when free disk is below the floor",
  );
  assert.equal(
    shouldRunStorageMaintenance(inWindow, config(), null),
    false,
    "maintenance should skip conservatively when free disk cannot be measured",
  );
  assert.equal(
    shouldRunStorageMaintenance(inWindow, config({ minFreeDiskBytes: 1024 }), 1024),
    true,
    "maintenance should run when enabled, in-window, and disk floor is satisfied",
  );

  const previousDataDir = process.env.KIKI_DATA_DIR;
  const previousEnabled = process.env.KIKI_DB_MAINT_ENABLED;
  const previousLowTraffic = process.env.KIKI_DB_MAINT_LOW_TRAFFIC_HOURS;
  const previousMinDisk = process.env.KIKI_DB_MAINT_MIN_FREE_DISK_BYTES;
  const previousMinReclaim = process.env.KIKI_DB_MAINT_MIN_RECLAIM_BYTES;
  const previousRatio = process.env.KIKI_DB_MAINT_FREELIST_RATIO;
  const previousMaxDbs = process.env.KIKI_DB_MAINT_MAX_DBS_PER_CYCLE;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kiki-storage-maint-runner-"));
  const originalError = console.error;
  const logs: string[] = [];
  try {
    process.env.KIKI_DATA_DIR = dataDir;
    process.env.KIKI_DB_MAINT_ENABLED = "true";
    process.env.KIKI_DB_MAINT_LOW_TRAFFIC_HOURS = "0-0";
    process.env.KIKI_DB_MAINT_MIN_FREE_DISK_BYTES = "1";
    process.env.KIKI_DB_MAINT_MIN_RECLAIM_BYTES = "1";
    process.env.KIKI_DB_MAINT_FREELIST_RATIO = "0.01";
    process.env.KIKI_DB_MAINT_MAX_DBS_PER_CYCLE = "1";
    closeRegistryDatabase();

    insertRegistryUser("user-no-reclaim", "2026-06-01T00:00:00.000Z");
    insertRegistryUser("user-needs-reclaim", "2026-06-02T00:00:00.000Z");
    createUserDb(dataDir, "user-no-reclaim", false);
    createUserDb(dataDir, "user-needs-reclaim", true);

    console.error = (message?: unknown, ...args: unknown[]) => {
      logs.push([message, ...args].map(String).join(" "));
    };
    runStorageMaintenanceTick(new Date("2026-06-22T12:00:00Z"));
    assert.ok(
      logs.some((line) => line.includes("user:reclaim:done") && line.includes('"userId":"user-needs-reclaim"')),
      "maintenance should scan past non-reclaiming early users before applying maxDbsPerCycle",
    );
    assert.equal(
      logs.some((line) => line.includes("user:reclaim:done") && line.includes('"userId":"user-no-reclaim"')),
      false,
      "non-reclaiming users should not count as processed databases",
    );
  } finally {
    console.error = originalError;
    closeRegistryDatabase();
    if (previousDataDir === undefined) delete process.env.KIKI_DATA_DIR;
    else process.env.KIKI_DATA_DIR = previousDataDir;
    if (previousEnabled === undefined) delete process.env.KIKI_DB_MAINT_ENABLED;
    else process.env.KIKI_DB_MAINT_ENABLED = previousEnabled;
    if (previousLowTraffic === undefined) delete process.env.KIKI_DB_MAINT_LOW_TRAFFIC_HOURS;
    else process.env.KIKI_DB_MAINT_LOW_TRAFFIC_HOURS = previousLowTraffic;
    if (previousMinDisk === undefined) delete process.env.KIKI_DB_MAINT_MIN_FREE_DISK_BYTES;
    else process.env.KIKI_DB_MAINT_MIN_FREE_DISK_BYTES = previousMinDisk;
    if (previousMinReclaim === undefined) delete process.env.KIKI_DB_MAINT_MIN_RECLAIM_BYTES;
    else process.env.KIKI_DB_MAINT_MIN_RECLAIM_BYTES = previousMinReclaim;
    if (previousRatio === undefined) delete process.env.KIKI_DB_MAINT_FREELIST_RATIO;
    else process.env.KIKI_DB_MAINT_FREELIST_RATIO = previousRatio;
    if (previousMaxDbs === undefined) delete process.env.KIKI_DB_MAINT_MAX_DBS_PER_CYCLE;
    else process.env.KIKI_DB_MAINT_MAX_DBS_PER_CYCLE = previousMaxDbs;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  console.log("storageMaintenanceRunner specs passed");
}

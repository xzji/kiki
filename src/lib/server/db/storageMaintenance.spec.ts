import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

import {
  inspectDbStorage,
  runFullCompaction,
  runLightReclaim,
  shouldReclaim,
  StorageMaintenanceError,
  type DbStorageMetrics,
} from "./storageMaintenance";
import type { StorageMaintenanceConfig } from "./storageMaintenanceConfig";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kiki-storage-maintenance-"));
}

function createReclaimableDb(dbPath: string, options: { incremental?: boolean } = {}) {
  const db = new Database(dbPath);
  try {
    db.pragma("journal_mode = WAL");
    if (options.incremental) {
      db.pragma("auto_vacuum = INCREMENTAL");
    }
    db.exec(`
      CREATE TABLE payloads (
        id INTEGER PRIMARY KEY,
        payload TEXT NOT NULL
      )
    `);
    const payload = "x".repeat(2048);
    const insert = db.prepare(`INSERT INTO payloads (payload) VALUES (?)`);
    const insertMany = db.transaction(() => {
      for (let i = 0; i < 900; i += 1) {
        insert.run(payload);
      }
    });
    insertMany();
    db.prepare(`DELETE FROM payloads WHERE id <= ?`).run(750);
    db.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}

function config(overrides: Partial<StorageMaintenanceConfig> = {}): StorageMaintenanceConfig {
  return {
    enabled: true,
    freelistRatioThreshold: 0.5,
    minReclaimableBytes: 1024,
    intervalMs: 1,
    maxDbsPerCycle: 1,
    minFreeDiskBytes: 1,
    lowTrafficHours: { startHour: 0, endHour: 0 },
    ...overrides,
  };
}

function metrics(overrides: Partial<DbStorageMetrics> = {}): DbStorageMetrics {
  return {
    dbPath: "/tmp/kiki.db",
    pageCount: 100,
    freelistCount: 60,
    pageSize: 4096,
    dbBytes: 409_600,
    walBytes: 0,
    shmBytes: 0,
    totalBytes: 409_600,
    reclaimableBytes: 60 * 4096,
    autoVacuum: 0,
    ...overrides,
  };
}

export function runStorageMaintenanceSpecs() {
  const missingDir = makeTempDir();
  try {
    assert.throws(
      () => inspectDbStorage(path.join(missingDir, "missing.db")),
      StorageMaintenanceError,
      "missing database should throw a clear storage maintenance error",
    );
  } finally {
    fs.rmSync(missingDir, { recursive: true, force: true });
  }

  const inspectDir = makeTempDir();
  try {
    const dbPath = path.join(inspectDir, "kiki.db");
    createReclaimableDb(dbPath);
    const inspected = inspectDbStorage(dbPath);
    assert.equal(inspected.dbPath, dbPath);
    assert.ok(inspected.pageCount > 0, "page_count should be populated");
    assert.ok(inspected.pageSize > 0, "page_size should be populated");
    assert.ok(inspected.freelistCount > 0, "deleting rows should leave free pages");
    assert.ok(inspected.reclaimableBytes > 0, "free pages should be reported as reclaimable bytes");
    assert.equal(inspected.totalBytes, inspected.dbBytes + inspected.walBytes + inspected.shmBytes);
  } finally {
    fs.rmSync(inspectDir, { recursive: true, force: true });
  }

  assert.equal(shouldReclaim(metrics(), config()), true);
  assert.equal(
    shouldReclaim(metrics({ freelistCount: 40, reclaimableBytes: 40 * 4096 }), config()),
    false,
    "free page ratio must meet threshold",
  );
  assert.equal(
    shouldReclaim(metrics({ reclaimableBytes: 512 }), config({ minReclaimableBytes: 1024 })),
    false,
    "reclaimable bytes must meet threshold",
  );

  const lightDir = makeTempDir();
  try {
    const dbPath = path.join(lightDir, "kiki.db");
    createReclaimableDb(dbPath, { incremental: true });
    const db = new Database(dbPath);
    try {
      const result = runLightReclaim(db, dbPath);
      assert.equal(result.before.dbPath, dbPath);
      assert.equal(result.after.dbPath, dbPath);
      assert.ok(result.before.pageCount > 0);
      assert.ok(result.after.pageCount > 0);
      assert.ok(result.reclaimedBytes >= 0);
      const remaining = db.prepare(`SELECT COUNT(*) AS count FROM payloads`).get() as { count: number };
      assert.equal(remaining.count, 150);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(lightDir, { recursive: true, force: true });
  }

  const compactDir = makeTempDir();
  try {
    const dbPath = path.join(compactDir, "kiki.db");
    createReclaimableDb(dbPath);
    const before = inspectDbStorage(dbPath);
    const result = runFullCompaction({ dbPath });
    const verify = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const row = verify.prepare(`SELECT COUNT(*) AS count FROM payloads`).get() as { count: number };
      assert.equal(row.count, 150, "full compaction should preserve table data");
    } finally {
      verify.close();
    }
    assert.equal(result.before.dbPath, dbPath);
    assert.equal(result.after.dbPath, dbPath);
    assert.equal(result.after.autoVacuum, 2, "full compaction should migrate legacy DBs to incremental auto_vacuum");
    assert.ok(result.after.totalBytes <= before.totalBytes, "full compaction should not grow total file bytes");
    assert.ok(result.reclaimedBytes >= 0);
  } finally {
    fs.rmSync(compactDir, { recursive: true, force: true });
  }

  console.log("storageMaintenance specs passed");
}

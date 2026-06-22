import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { closeDatabaseForReset } from "./client";
import { logger } from "./storageMaintenanceLogger";
import type { StorageMaintenanceConfig } from "./storageMaintenanceConfig";

export type DbStorageMetrics = {
  dbPath: string | null;
  pageCount: number;
  freelistCount: number;
  pageSize: number;
  dbBytes: number;
  walBytes: number;
  shmBytes: number;
  totalBytes: number;
  reclaimableBytes: number;
  autoVacuum: number;
};

export type LightReclaimResult = {
  before: DbStorageMetrics;
  after: DbStorageMetrics;
  reclaimedBytes: number;
};

export type FullCompactionOptions = {
  userId?: string;
  dbPath: string;
};

export type FullCompactionResult = {
  before: DbStorageMetrics;
  after: DbStorageMetrics;
  reclaimedBytes: number;
};

export class StorageMaintenanceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StorageMaintenanceError";
  }
}

type CheckpointRow = {
  busy?: number;
  log?: number;
  checkpointed?: number;
};

function readPragmaNumber(db: Database.Database, pragma: string) {
  const value = db.pragma(pragma, { simple: true });
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function fileBytes(filePath: string) {
  try {
    return fs.statSync(filePath).size;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

function collectMetricsFromDb(db: Database.Database, dbPath?: string): DbStorageMetrics {
  const pageCount = readPragmaNumber(db, "page_count");
  const freelistCount = readPragmaNumber(db, "freelist_count");
  const pageSize = readPragmaNumber(db, "page_size");
  const autoVacuum = readPragmaNumber(db, "auto_vacuum");
  const resolvedPath = dbPath ?? null;
  const dbBytes = resolvedPath ? fileBytes(resolvedPath) : 0;
  const walBytes = resolvedPath ? fileBytes(`${resolvedPath}-wal`) : 0;
  const shmBytes = resolvedPath ? fileBytes(`${resolvedPath}-shm`) : 0;

  return {
    dbPath: resolvedPath,
    pageCount,
    freelistCount,
    pageSize,
    dbBytes,
    walBytes,
    shmBytes,
    totalBytes: dbBytes + walBytes + shmBytes,
    reclaimableBytes: freelistCount * pageSize,
    autoVacuum,
  };
}

function ensureDatabaseFileExists(dbPath: string) {
  if (!fs.existsSync(dbPath)) {
    logger.info("database_file:missing", { dbPath });
    throw new StorageMaintenanceError(`SQLite database does not exist: ${dbPath}`);
  }
}

function checkpointTruncate(db: Database.Database, context: string) {
  logger.info("wal_checkpoint_truncate:start", { context });
  const rows = db.pragma("wal_checkpoint(TRUNCATE)") as CheckpointRow[];
  const busy = rows.some((row) => Number(row.busy ?? 0) > 0);
  if (busy) {
    logger.info("wal_checkpoint_truncate:busy", { context, rows });
    throw new StorageMaintenanceError(`SQLite WAL checkpoint was busy during ${context}`);
  }
  logger.info("wal_checkpoint_truncate:done", { context, rows });
}

function removeSidecarFiles(dbPath: string) {
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
}

function makeTempCompactionPath(dbPath: string) {
  const directory = path.dirname(dbPath);
  const basename = path.basename(dbPath);
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return path.join(directory, `${basename}.compact-${suffix}.tmp`);
}

function assertIntegrityOk(dbPath: string) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const result = db.pragma("integrity_check", { simple: true });
    if (result !== "ok") {
      throw new StorageMaintenanceError(`Compacted SQLite integrity_check failed for ${dbPath}: ${String(result)}`);
    }
  } finally {
    db.close();
  }
}

function removeTempArtifacts(tempDbPath: string) {
  fs.rmSync(tempDbPath, { force: true });
  removeSidecarFiles(tempDbPath);
}

export function inspectDbStorage(dbPath: string): DbStorageMetrics {
  logger.info("inspect:start", { dbPath });
  ensureDatabaseFileExists(dbPath);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const metrics = collectMetricsFromDb(db, dbPath);
    logger.info("inspect:done", {
      dbPath,
      pageCount: metrics.pageCount,
      freelistCount: metrics.freelistCount,
      reclaimableBytes: metrics.reclaimableBytes,
      totalBytes: metrics.totalBytes,
      autoVacuum: metrics.autoVacuum,
    });
    return metrics;
  } catch (error) {
    logger.info("inspect:failed", { dbPath, error: error instanceof Error ? error.message : String(error) });
    throw new StorageMaintenanceError(`Failed to inspect SQLite storage for ${dbPath}`, { cause: error });
  } finally {
    db.close();
  }
}

export function runLightReclaim(db: Database.Database, dbPath?: string): LightReclaimResult {
  const before = collectMetricsFromDb(db, dbPath);
  logger.info("light_reclaim:start", {
    dbPath,
    pageCount: before.pageCount,
    freelistCount: before.freelistCount,
    reclaimableBytes: before.reclaimableBytes,
    totalBytes: before.totalBytes,
    autoVacuum: before.autoVacuum,
  });
  db.pragma("incremental_vacuum");
  checkpointTruncate(db, "light reclaim");
  const after = collectMetricsFromDb(db, dbPath);
  const reclaimedBytes = Math.max(0, before.totalBytes - after.totalBytes);
  logger.info("light_reclaim:done", {
    dbPath,
    beforeTotalBytes: before.totalBytes,
    afterTotalBytes: after.totalBytes,
    beforeFreelistCount: before.freelistCount,
    afterFreelistCount: after.freelistCount,
    reclaimedBytes,
    autoVacuum: after.autoVacuum,
  });

  return {
    before,
    after,
    reclaimedBytes,
  };
}

export function runFullCompaction({ userId, dbPath }: FullCompactionOptions): FullCompactionResult {
  logger.info("full_compaction:start", { userId, dbPath });
  ensureDatabaseFileExists(dbPath);
  if (userId) {
    logger.info("full_compaction:close_cached_connection", { userId, dbPath });
    closeDatabaseForReset(userId);
  }

  const before = inspectDbStorage(dbPath);
  const tempDbPath = makeTempCompactionPath(dbPath);
  let source: Database.Database | null = null;

  try {
    logger.info("full_compaction:open_source", { dbPath, tempDbPath });
    source = new Database(dbPath, { fileMustExist: true });
    source.pragma("busy_timeout = 5000");
    checkpointTruncate(source, "full compaction");
    source.pragma("auto_vacuum = INCREMENTAL");
    logger.info("full_compaction:vacuum_into:start", { dbPath, tempDbPath });
    source.prepare("VACUUM INTO ?").run(tempDbPath);
    source.close();
    source = null;
    logger.info("full_compaction:vacuum_into:done", { dbPath, tempDbPath });

    logger.info("full_compaction:integrity_check:start", { tempDbPath });
    assertIntegrityOk(tempDbPath);
    logger.info("full_compaction:integrity_check:done", { tempDbPath });
    logger.info("full_compaction:replace:start", { dbPath, tempDbPath });
    removeSidecarFiles(dbPath);
    fs.renameSync(tempDbPath, dbPath);
    removeSidecarFiles(dbPath);
    logger.info("full_compaction:replace:done", { dbPath });

    const compacted = new Database(dbPath, { fileMustExist: true });
    try {
      compacted.pragma("busy_timeout = 5000");
      checkpointTruncate(compacted, "post-compaction reopen");
    } finally {
      compacted.close();
    }
    removeSidecarFiles(dbPath);

    const after = inspectDbStorage(dbPath);
    const reclaimedBytes = Math.max(0, before.totalBytes - after.totalBytes);
    logger.info("full_compaction:done", {
      userId,
      dbPath,
      beforeTotalBytes: before.totalBytes,
      afterTotalBytes: after.totalBytes,
      beforeAutoVacuum: before.autoVacuum,
      afterAutoVacuum: after.autoVacuum,
      reclaimedBytes,
    });
    return {
      before,
      after,
      reclaimedBytes,
    };
  } catch (error) {
    if (source?.open) {
      source.close();
    }
    removeTempArtifacts(tempDbPath);
    logger.info("full_compaction:failed", {
      userId,
      dbPath,
      tempDbPath,
      error: error instanceof Error ? error.message : String(error),
    });
    if (error instanceof StorageMaintenanceError) {
      throw error;
    }
    throw new StorageMaintenanceError(`Failed to compact SQLite database ${dbPath}`, { cause: error });
  }
}

export function shouldReclaim(metrics: DbStorageMetrics, config: StorageMaintenanceConfig): boolean {
  const freelistRatio = metrics.pageCount > 0 ? metrics.freelistCount / metrics.pageCount : 0;
  return (
    freelistRatio >= config.freelistRatioThreshold &&
    metrics.reclaimableBytes >= config.minReclaimableBytes
  );
}

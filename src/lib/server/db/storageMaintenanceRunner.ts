import fs from "node:fs";

import { runWithUserContext } from "@/lib/server/context/userContext";
import { getDatabase } from "@/lib/server/db/client";
import {
  inspectDbStorage,
  runLightReclaim,
  shouldReclaim,
} from "@/lib/server/db/storageMaintenance";
import { logger } from "@/lib/server/db/storageMaintenanceLogger";
import {
  getStorageMaintenanceConfig,
  isWithinLowTrafficWindow,
  type StorageMaintenanceConfig,
} from "@/lib/server/db/storageMaintenanceConfig";
import { listActiveUserIdsForMaintenance } from "@/lib/server/orchestrator/listUsersWithPendingWork";
import { getSystemDataDir, getDatabaseFilePath } from "@/lib/server/storage/paths";

export function getAvailableFilesystemBytes(targetPath = getSystemDataDir()): number | null {
  if (typeof fs.statfsSync !== "function") {
    logger.info("disk_probe:unsupported", { targetPath });
    return null;
  }

  try {
    const stats = fs.statfsSync(targetPath);
    const availableBytes = stats.bavail * stats.bsize;
    logger.info("disk_probe:done", { targetPath, availableBytes });
    return availableBytes;
  } catch {
    logger.info("disk_probe:failed", { targetPath });
    return null;
  }
}

export function shouldRunStorageMaintenance(
  now: Date,
  config: StorageMaintenanceConfig,
  freeDiskBytes: number | null,
): boolean {
  if (!config.enabled) {
    logger.info("tick_guard:skip_disabled");
    return false;
  }
  if (!isWithinLowTrafficWindow(now, config.lowTrafficHours)) {
    logger.info("tick_guard:skip_outside_low_traffic_window", {
      now: now.toISOString(),
      lowTrafficHours: config.lowTrafficHours,
    });
    return false;
  }
  if (freeDiskBytes === null || freeDiskBytes < config.minFreeDiskBytes) {
    logger.info("tick_guard:skip_low_disk", {
      freeDiskBytes,
      minFreeDiskBytes: config.minFreeDiskBytes,
    });
    return false;
  }
  logger.info("tick_guard:pass", {
    now: now.toISOString(),
    freeDiskBytes,
    minFreeDiskBytes: config.minFreeDiskBytes,
    lowTrafficHours: config.lowTrafficHours,
  });
  return true;
}

export function runStorageMaintenanceTick(now = new Date()): void {
  const config = getStorageMaintenanceConfig();
  logger.info("tick:start", {
    now: now.toISOString(),
    enabled: config.enabled,
    freelistRatioThreshold: config.freelistRatioThreshold,
    minReclaimableBytes: config.minReclaimableBytes,
    maxDbsPerCycle: config.maxDbsPerCycle,
    minFreeDiskBytes: config.minFreeDiskBytes,
    lowTrafficHours: config.lowTrafficHours,
  });
  const freeDiskBytes = getAvailableFilesystemBytes();
  if (!shouldRunStorageMaintenance(now, config, freeDiskBytes)) {
    logger.info("tick:skipped");
    return;
  }

  const userIds = listActiveUserIdsForMaintenance();
  logger.info("tick:users_loaded", { activeUserCount: userIds.length });
  let reclaimedDatabaseCount = 0;
  let inspectedDatabaseCount = 0;
  for (const userId of userIds) {
    if (reclaimedDatabaseCount >= config.maxDbsPerCycle) {
      logger.info("tick:stop_max_reclaimed_databases", {
        maxDbsPerCycle: config.maxDbsPerCycle,
        inspectedDatabaseCount,
        reclaimedDatabaseCount,
      });
      break;
    }
    try {
      runWithUserContext(userId, () => {
        const dbPath = getDatabaseFilePath();
        logger.info("user:inspect:start", { userId, dbPath });
        const metrics = inspectDbStorage(dbPath);
        inspectedDatabaseCount += 1;
        if (!shouldReclaim(metrics, config)) {
          logger.info("user:skip_below_threshold", {
            userId,
            dbPath,
            pageCount: metrics.pageCount,
            freelistCount: metrics.freelistCount,
            freelistRatio: metrics.pageCount > 0 ? metrics.freelistCount / metrics.pageCount : 0,
            reclaimableBytes: metrics.reclaimableBytes,
            thresholdRatio: config.freelistRatioThreshold,
            thresholdBytes: config.minReclaimableBytes,
          });
          return;
        }

        logger.info("user:reclaim:start", {
          userId,
          dbPath,
          pageCount: metrics.pageCount,
          freelistCount: metrics.freelistCount,
          reclaimableBytes: metrics.reclaimableBytes,
          totalBytes: metrics.totalBytes,
        });
        const db = getDatabase();
        const result = runLightReclaim(db, dbPath);
        reclaimedDatabaseCount += 1;
        logger.info("user:reclaim:done", {
          userId,
          dbPath,
          reclaimedBytes: result.reclaimedBytes,
          beforeBytes: result.before.totalBytes,
          afterBytes: result.after.totalBytes,
          reclaimedDatabaseCount,
        });
      });
    } catch (error) {
      logger.info("user:error", { userId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  logger.info("tick:done", { inspectedDatabaseCount, reclaimedDatabaseCount });
}

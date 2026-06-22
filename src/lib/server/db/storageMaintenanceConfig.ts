export type LowTrafficWindow = {
  startHour: number;
  endHour: number;
};

export type StorageMaintenanceConfig = {
  enabled: boolean;
  freelistRatioThreshold: number;
  minReclaimableBytes: number;
  intervalMs: number;
  maxDbsPerCycle: number;
  minFreeDiskBytes: number;
  lowTrafficHours: LowTrafficWindow;
};

const DEFAULT_FREELIST_RATIO = 0.5;
const DEFAULT_MIN_RECLAIM_BYTES = 50 * 1024 * 1024;
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MAX_DBS_PER_CYCLE = 3;
const DEFAULT_MIN_FREE_DISK_BYTES = 1024 * 1024 * 1024;
const DEFAULT_LOW_TRAFFIC_HOURS: LowTrafficWindow = { startHour: 2, endHour: 6 };

function readPositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function readBoolean(value: string | undefined, fallback: boolean) {
  if (value === undefined) {
    return fallback;
  }
  return value.trim().toLowerCase() !== "false";
}

function readRatio(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

function isHour(value: number) {
  return Number.isInteger(value) && value >= 0 && value <= 23;
}

function readLowTrafficWindow(value: string | undefined, fallback: LowTrafficWindow): LowTrafficWindow {
  if (value === undefined) {
    return fallback;
  }
  const parts = value.trim().split("-");
  if (parts.length !== 2) {
    return fallback;
  }
  const startHour = Number(parts[0]);
  const endHour = Number(parts[1]);
  if (!isHour(startHour) || !isHour(endHour)) {
    return fallback;
  }
  return { startHour, endHour };
}

export function getStorageMaintenanceConfig(): StorageMaintenanceConfig {
  return {
    enabled: readBoolean(process.env.KIKI_DB_MAINT_ENABLED, true),
    freelistRatioThreshold: readRatio(process.env.KIKI_DB_MAINT_FREELIST_RATIO, DEFAULT_FREELIST_RATIO),
    minReclaimableBytes: readPositiveInt(process.env.KIKI_DB_MAINT_MIN_RECLAIM_BYTES, DEFAULT_MIN_RECLAIM_BYTES),
    intervalMs: readPositiveInt(process.env.KIKI_DB_MAINT_INTERVAL_MS, DEFAULT_INTERVAL_MS),
    maxDbsPerCycle: readPositiveInt(process.env.KIKI_DB_MAINT_MAX_DBS_PER_CYCLE, DEFAULT_MAX_DBS_PER_CYCLE),
    minFreeDiskBytes: readPositiveInt(process.env.KIKI_DB_MAINT_MIN_FREE_DISK_BYTES, DEFAULT_MIN_FREE_DISK_BYTES),
    lowTrafficHours: readLowTrafficWindow(process.env.KIKI_DB_MAINT_LOW_TRAFFIC_HOURS, DEFAULT_LOW_TRAFFIC_HOURS),
  };
}

export function isWithinLowTrafficWindow(date: Date, window: LowTrafficWindow): boolean {
  const hour = date.getUTCHours();
  const { startHour, endHour } = window;
  if (startHour === endHour) {
    return true;
  }
  if (startHour < endHour) {
    return hour >= startHour && hour < endHour;
  }
  return hour >= startHour || hour < endHour;
}

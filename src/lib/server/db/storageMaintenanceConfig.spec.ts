import assert from "assert";

import {
  getStorageMaintenanceConfig,
  isWithinLowTrafficWindow,
} from "./storageMaintenanceConfig";

const MAINT_ENV_KEYS = [
  "KIKI_DB_MAINT_ENABLED",
  "KIKI_DB_MAINT_FREELIST_RATIO",
  "KIKI_DB_MAINT_MIN_RECLAIM_BYTES",
  "KIKI_DB_MAINT_INTERVAL_MS",
  "KIKI_DB_MAINT_MAX_DBS_PER_CYCLE",
  "KIKI_DB_MAINT_MIN_FREE_DISK_BYTES",
  "KIKI_DB_MAINT_LOW_TRAFFIC_HOURS",
] as const;

function clearMaintEnv() {
  for (const key of MAINT_ENV_KEYS) {
    delete process.env[key];
  }
}

export function runStorageMaintenanceConfigSpecs() {
  const previous = new Map<string, string | undefined>();
  for (const key of MAINT_ENV_KEYS) {
    previous.set(key, process.env[key]);
  }

  try {
    clearMaintEnv();
    const defaults = getStorageMaintenanceConfig();
    assert.strictEqual(defaults.enabled, true);
    assert.strictEqual(defaults.freelistRatioThreshold, 0.5);
    assert.strictEqual(defaults.minReclaimableBytes, 50 * 1024 * 1024);
    assert.strictEqual(defaults.intervalMs, 6 * 60 * 60 * 1000);
    assert.strictEqual(defaults.maxDbsPerCycle, 3);
    assert.strictEqual(defaults.minFreeDiskBytes, 1024 * 1024 * 1024);
    assert.deepStrictEqual(defaults.lowTrafficHours, { startHour: 2, endHour: 6 });

    clearMaintEnv();
    process.env.KIKI_DB_MAINT_FREELIST_RATIO = "0.75";
    process.env.KIKI_DB_MAINT_MIN_RECLAIM_BYTES = "1024";
    process.env.KIKI_DB_MAINT_INTERVAL_MS = "3600000";
    process.env.KIKI_DB_MAINT_MAX_DBS_PER_CYCLE = "10";
    process.env.KIKI_DB_MAINT_MIN_FREE_DISK_BYTES = "2048";
    process.env.KIKI_DB_MAINT_LOW_TRAFFIC_HOURS = "22-6";
    const overridden = getStorageMaintenanceConfig();
    assert.strictEqual(overridden.freelistRatioThreshold, 0.75);
    assert.strictEqual(overridden.minReclaimableBytes, 1024);
    assert.strictEqual(overridden.intervalMs, 3600000);
    assert.strictEqual(overridden.maxDbsPerCycle, 10);
    assert.strictEqual(overridden.minFreeDiskBytes, 2048);
    assert.deepStrictEqual(overridden.lowTrafficHours, { startHour: 22, endHour: 6 });

    clearMaintEnv();
    process.env.KIKI_DB_MAINT_ENABLED = "false";
    assert.strictEqual(getStorageMaintenanceConfig().enabled, false);
    process.env.KIKI_DB_MAINT_ENABLED = "FALSE";
    assert.strictEqual(getStorageMaintenanceConfig().enabled, false);
    process.env.KIKI_DB_MAINT_ENABLED = "true";
    assert.strictEqual(getStorageMaintenanceConfig().enabled, true);
    process.env.KIKI_DB_MAINT_ENABLED = "anything";
    assert.strictEqual(getStorageMaintenanceConfig().enabled, true);

    clearMaintEnv();
    process.env.KIKI_DB_MAINT_FREELIST_RATIO = "1.5";
    process.env.KIKI_DB_MAINT_MIN_RECLAIM_BYTES = "-1";
    process.env.KIKI_DB_MAINT_MAX_DBS_PER_CYCLE = "not-a-number";
    process.env.KIKI_DB_MAINT_LOW_TRAFFIC_HOURS = "99-100";
    const invalid = getStorageMaintenanceConfig();
    assert.strictEqual(invalid.freelistRatioThreshold, 0.5);
    assert.strictEqual(invalid.minReclaimableBytes, 50 * 1024 * 1024);
    assert.strictEqual(invalid.maxDbsPerCycle, 3);
    assert.deepStrictEqual(invalid.lowTrafficHours, { startHour: 2, endHour: 6 });

    process.env.KIKI_DB_MAINT_LOW_TRAFFIC_HOURS = "garbage";
    assert.deepStrictEqual(getStorageMaintenanceConfig().lowTrafficHours, { startHour: 2, endHour: 6 });

    const overnight = { startHour: 22, endHour: 6 };
    assert.strictEqual(isWithinLowTrafficWindow(new Date("2026-06-22T23:00:00Z"), overnight), true);
    assert.strictEqual(isWithinLowTrafficWindow(new Date("2026-06-22T03:00:00Z"), overnight), true);
    assert.strictEqual(isWithinLowTrafficWindow(new Date("2026-06-22T06:00:00Z"), overnight), false);
    assert.strictEqual(isWithinLowTrafficWindow(new Date("2026-06-22T12:00:00Z"), overnight), false);

    const daytime = { startHour: 2, endHour: 6 };
    assert.strictEqual(isWithinLowTrafficWindow(new Date("2026-06-22T02:00:00Z"), daytime), true);
    assert.strictEqual(isWithinLowTrafficWindow(new Date("2026-06-22T05:00:00Z"), daytime), true);
    assert.strictEqual(isWithinLowTrafficWindow(new Date("2026-06-22T06:00:00Z"), daytime), false);
    assert.strictEqual(isWithinLowTrafficWindow(new Date("2026-06-22T01:00:00Z"), daytime), false);

    const allDay = { startHour: 3, endHour: 3 };
    assert.strictEqual(isWithinLowTrafficWindow(new Date("2026-06-22T00:00:00Z"), allDay), true);
    assert.strictEqual(isWithinLowTrafficWindow(new Date("2026-06-22T15:00:00Z"), allDay), true);
  } finally {
    for (const key of MAINT_ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  console.log("storageMaintenanceConfig specs passed");
}

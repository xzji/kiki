export type StorageMaintenanceLogFields = Record<string, unknown>;

function write(level: "info" | "warn", message: string, fields?: StorageMaintenanceLogFields) {
  const suffix = fields ? ` ${JSON.stringify(fields)}` : "";
  // Keep stdout available for CLI JSON output while still surfacing maintenance diagnostics.
  console.error(`[storage-maintenance] ${level} ${message}${suffix}`);
}

export const logger = {
  info(message: string, fields?: StorageMaintenanceLogFields) {
    write("info", message, fields);
  },
  warn(message: string, fields?: StorageMaintenanceLogFields) {
    write("warn", message, fields);
  },
};

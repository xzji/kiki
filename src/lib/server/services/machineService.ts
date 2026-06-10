import { createHash, randomBytes, timingSafeEqual } from "crypto";

import { getOrchestratorConfig } from "@/lib/server/orchestrator/orchestratorConfig";
import { getRegistryDatabase } from "@/lib/server/db/registryClient";

export type MachineRecord = {
  id: string;
  userId: string;
  name: string | null;
  fingerprint: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  online: boolean;
};

type MachineRow = {
  id: string;
  user_id: string;
  api_key_hash: string;
  name: string | null;
  fingerprint: string | null;
  last_seen_at: string | null;
  created_at: string;
};

function nowIso() {
  return new Date().toISOString();
}

function hashApiKey(apiKey: string) {
  return createHash("sha256").update(apiKey).digest("hex");
}

function createMachineId() {
  return `machine-${randomBytes(12).toString("hex")}`;
}

function createApiKey() {
  return `sk_machine_${randomBytes(32).toString("hex")}`;
}

function isOnline(lastSeenAt: string | null) {
  if (!lastSeenAt) return false;
  const threshold = getOrchestratorConfig().machineOnlineThresholdMs;
  return Date.now() - new Date(lastSeenAt).getTime() <= threshold;
}

function toMachineRecord(row: MachineRow): MachineRecord {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    fingerprint: row.fingerprint,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    online: isOnline(row.last_seen_at),
  };
}

function isStableDeviceFingerprint(fingerprint: string) {
  return fingerprint.startsWith("device:");
}

function canUpgradeLegacyFingerprint(storedFingerprint: string, incomingFingerprint: string) {
  return (
    !isStableDeviceFingerprint(storedFingerprint) &&
    isStableDeviceFingerprint(incomingFingerprint) &&
    incomingFingerprint.startsWith(`device:${storedFingerprint}:`)
  );
}

function deleteDuplicateStableFingerprintMachines(input: {
  machineId: string;
  fingerprint: string;
}) {
  const fingerprint = input.fingerprint.trim();
  if (!isStableDeviceFingerprint(fingerprint)) return;
  const db = getRegistryDatabase();
  db.prepare(
    `
      DELETE FROM machines
      WHERE id <> ?
        AND fingerprint = ?
        AND user_id = (SELECT user_id FROM machines WHERE id = ?)
    `,
  ).run(input.machineId, fingerprint, input.machineId);
}

/** 清理从未连上过（无心跳）的占位记录，避免反复打开弹窗堆积 My Machine */
export function deleteNeverConnectedMachinesForUser(userId: string) {
  const db = getRegistryDatabase();
  db.prepare(`DELETE FROM machines WHERE user_id = ? AND last_seen_at IS NULL`).run(userId);
}

export function deleteMachineForUser(input: { userId: string; machineId: string }) {
  const db = getRegistryDatabase();
  const result = db
    .prepare(`DELETE FROM machines WHERE id = ? AND user_id = ?`)
    .run(input.machineId, input.userId);
  return result.changes > 0;
}

export function createMachineForUser(input: {
  userId: string;
  name?: string;
  fingerprint?: string;
}): { machine: MachineRecord; apiKey: string } {
  const db = getRegistryDatabase();
  deleteNeverConnectedMachinesForUser(input.userId);
  const machineId = createMachineId();
  const apiKey = createApiKey();
  const createdAt = nowIso();
  db.prepare(
    `
      INSERT INTO machines (id, user_id, api_key_hash, name, fingerprint, last_seen_at, created_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?)
    `,
  ).run(
    machineId,
    input.userId,
    hashApiKey(apiKey),
    input.name?.trim() || "My Machine",
    input.fingerprint?.trim() || null,
    createdAt,
  );
  const row = db.prepare(`SELECT * FROM machines WHERE id = ? LIMIT 1`).get(machineId) as MachineRow;
  return { machine: toMachineRecord(row), apiKey };
}

export function listMachinesForUser(userId: string): MachineRecord[] {
  const db = getRegistryDatabase();
  const rows = db
    .prepare(`SELECT * FROM machines WHERE user_id = ? ORDER BY created_at DESC`)
    .all(userId) as MachineRow[];
  return rows.map(toMachineRecord);
}

export function getOnlineMachinesForUser(userId: string) {
  return listMachinesForUser(userId).filter((machine) => machine.online);
}

export type AuthenticatedMachine = {
  machineId: string;
  userId: string;
  name: string | null;
  fingerprint: string | null;
};

export function authenticateMachineApiKey(apiKey: string): AuthenticatedMachine | null {
  if (!apiKey.startsWith("sk_machine_")) return null;
  const db = getRegistryDatabase();
  const hash = hashApiKey(apiKey);
  const row = db
    .prepare(`SELECT * FROM machines WHERE api_key_hash = ? LIMIT 1`)
    .get(hash) as MachineRow | undefined;
  if (!row) return null;
  const stored = Buffer.from(row.api_key_hash, "hex");
  const provided = Buffer.from(hash, "hex");
  if (stored.length !== provided.length || !timingSafeEqual(stored, provided)) {
    return null;
  }
  return {
    machineId: row.id,
    userId: row.user_id,
    name: row.name,
    fingerprint: row.fingerprint,
  };
}

export function touchMachineHeartbeat(machineId: string, fingerprint?: string) {
  const db = getRegistryDatabase();
  const now = nowIso();
  if (fingerprint?.trim()) {
    const normalizedFingerprint = fingerprint.trim();
    db.prepare(
      `
        UPDATE machines
        SET last_seen_at = ?, fingerprint = COALESCE(fingerprint, ?)
        WHERE id = ?
      `,
    ).run(now, normalizedFingerprint, machineId);
    deleteDuplicateStableFingerprintMachines({ machineId, fingerprint: normalizedFingerprint });
    return;
  }
  db.prepare(`UPDATE machines SET last_seen_at = ? WHERE id = ?`).run(now, machineId);
}

export function assertMachineFingerprint(machineId: string, fingerprint: string) {
  const db = getRegistryDatabase();
  const row = db
    .prepare(`SELECT fingerprint FROM machines WHERE id = ? LIMIT 1`)
    .get(machineId) as { fingerprint: string | null } | undefined;
  if (!row) return { ok: false as const, reason: "machine 不存在" };
  if (!row.fingerprint) {
    db.prepare(`UPDATE machines SET fingerprint = ? WHERE id = ?`).run(fingerprint, machineId);
    deleteDuplicateStableFingerprintMachines({ machineId, fingerprint });
    return { ok: true as const };
  }
  if (canUpgradeLegacyFingerprint(row.fingerprint, fingerprint)) {
    db.prepare(`UPDATE machines SET fingerprint = ? WHERE id = ?`).run(fingerprint, machineId);
    deleteDuplicateStableFingerprintMachines({ machineId, fingerprint });
    return { ok: true as const };
  }
  if (row.fingerprint !== fingerprint) {
    return { ok: false as const, reason: "machine 指纹不匹配" };
  }
  return { ok: true as const };
}

import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";

import { closeRegistryDatabase, getRegistryDatabase } from "@/lib/server/db/registryClient";

import {
  assertMachineFingerprint,
  listMachinesForUser,
  touchMachineHeartbeat,
} from "./machineService";

function insertMachine(input: {
  id: string;
  userId: string;
  fingerprint: string | null;
  createdAt?: string;
}) {
  getRegistryDatabase()
    .prepare(
      `
        INSERT INTO machines (id, user_id, api_key_hash, name, fingerprint, last_seen_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      input.id,
      input.userId,
      `hash-${input.id}`,
      "My Machine",
      input.fingerprint,
      "2026-06-10T00:00:00.000Z",
      input.createdAt ?? "2026-06-10T00:00:00.000Z",
    );
}

export function runMachineServiceSpecs() {
  const previousDataDir = process.env.KIKI_DATA_DIR;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kiki-machine-service-spec-"));
  process.env.KIKI_DATA_DIR = dataDir;
  closeRegistryDatabase();

  try {
    insertMachine({
      id: "machine-legacy",
      userId: "user-a",
      fingerprint: "darwin-arm64",
    });

    const upgraded = assertMachineFingerprint(
      "machine-legacy",
      "device:darwin-arm64:stable-device-id",
    );
    assert.deepStrictEqual(upgraded, { ok: true });
    assert.strictEqual(
      listMachinesForUser("user-a").find((machine) => machine.id === "machine-legacy")?.fingerprint,
      "device:darwin-arm64:stable-device-id",
    );

    const mismatched = assertMachineFingerprint(
      "machine-legacy",
      "device:darwin-arm64:another-device-id",
    );
    assert.deepStrictEqual(mismatched, { ok: false, reason: "machine 指纹不匹配" });

    insertMachine({
      id: "machine-duplicate",
      userId: "user-a",
      fingerprint: "device:darwin-arm64:stable-device-id",
      createdAt: "2026-06-10T00:01:00.000Z",
    });
    touchMachineHeartbeat("machine-duplicate", "device:darwin-arm64:stable-device-id");
    assert.deepStrictEqual(
      listMachinesForUser("user-a").map((machine) => machine.id),
      ["machine-duplicate"],
    );

    insertMachine({
      id: "machine-other-user",
      userId: "user-b",
      fingerprint: "device:darwin-arm64:stable-device-id",
    });
    touchMachineHeartbeat("machine-other-user", "device:darwin-arm64:stable-device-id");
    assert.deepStrictEqual(
      listMachinesForUser("user-b").map((machine) => machine.id),
      ["machine-other-user"],
    );
  } finally {
    closeRegistryDatabase();
    if (previousDataDir === undefined) {
      delete process.env.KIKI_DATA_DIR;
    } else {
      process.env.KIKI_DATA_DIR = previousDataDir;
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
    closeRegistryDatabase();
  }
}

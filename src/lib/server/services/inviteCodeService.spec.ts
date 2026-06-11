import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";

import { closeRegistryDatabase, getRegistryDatabase } from "@/lib/server/db/registryClient";

import {
  consumeInviteCodeInTransaction,
  isValidInviteCodeFormat,
  releaseInviteCodeUseForUser,
} from "./inviteCodeService";

export function runInviteCodeServiceSpecs() {
  const previousDataDir = process.env.KIKI_DATA_DIR;
  const previousSeedInviteCodes = process.env.KIKI_SEED_INVITE_CODES;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kiki-invite-code-service-spec-"));
  process.env.KIKI_DATA_DIR = dataDir;
  delete process.env.KIKI_SEED_INVITE_CODES;
  closeRegistryDatabase();

  try {
    assert.strictEqual(isValidInviteCodeFormat("KIKIGOOD"), true);

    const db = getRegistryDatabase();
    const seeded = db
      .prepare(`SELECT code, max_uses, usage_count FROM invite_codes WHERE code = ? LIMIT 1`)
      .get("KIKIGOOD") as { code: string; max_uses: number; usage_count: number } | undefined;
    assert.deepStrictEqual(seeded, { code: "KIKIGOOD", max_uses: 100, usage_count: 0 });

    for (let i = 0; i < 100; i += 1) {
      assert.deepStrictEqual(
        consumeInviteCodeInTransaction(db, { code: "KIKIGOOD", userId: `user-${i}` }),
        { ok: true },
      );
    }
    assert.deepStrictEqual(consumeInviteCodeInTransaction(db, { code: "KIKIGOOD", userId: "user-over" }), {
      ok: false,
      reason: "邀请码使用次数已达上限",
      field: "inviteCode",
    });

    releaseInviteCodeUseForUser(db, "user-99");
    assert.deepStrictEqual(consumeInviteCodeInTransaction(db, { code: "KIKIGOOD", userId: "user-after-release" }), {
      ok: true,
    });
  } finally {
    closeRegistryDatabase();
    if (previousDataDir === undefined) {
      delete process.env.KIKI_DATA_DIR;
    } else {
      process.env.KIKI_DATA_DIR = previousDataDir;
    }
    if (previousSeedInviteCodes === undefined) {
      delete process.env.KIKI_SEED_INVITE_CODES;
    } else {
      process.env.KIKI_SEED_INVITE_CODES = previousSeedInviteCodes;
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
    closeRegistryDatabase();
  }
}

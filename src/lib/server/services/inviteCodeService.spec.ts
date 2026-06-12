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
    assert.strictEqual(isValidInviteCodeFormat("KIKIG00D"), true);
    assert.strictEqual(isValidInviteCodeFormat("ABCDEFGH"), true);
    assert.strictEqual(isValidInviteCodeFormat("12345678"), true);
    assert.strictEqual(isValidInviteCodeFormat("ABC1234"), false);

    const db = getRegistryDatabase();
    db.prepare(
      `INSERT INTO invite_codes (code, created_at, used_at, used_by_user_id, max_uses, usage_count) VALUES (?, datetime('now'), NULL, NULL, 1, 0)`,
    ).run("ABCDEFGH");
    const seeded = db
      .prepare(`SELECT code, max_uses, usage_count FROM invite_codes WHERE code = ? LIMIT 1`)
      .get("KIKIG00D") as { code: string; max_uses: number; usage_count: number } | undefined;
    assert.deepStrictEqual(seeded, { code: "KIKIG00D", max_uses: 100, usage_count: 0 });

    assert.deepStrictEqual(consumeInviteCodeInTransaction(db, { code: "ABCDEFGH", userId: "user-alpha-only" }), {
      ok: true,
    });
    assert.deepStrictEqual(consumeInviteCodeInTransaction(db, { code: "ABC1234", userId: "user-invalid-length" }), {
      ok: false,
      reason: "邀请码须为 8 位字母或数字组合",
      field: "inviteCode",
    });

    for (let i = 0; i < 100; i += 1) {
      assert.deepStrictEqual(
        consumeInviteCodeInTransaction(db, { code: "KIKIG00D", userId: `user-${i}` }),
        { ok: true },
      );
    }
    assert.deepStrictEqual(consumeInviteCodeInTransaction(db, { code: "KIKIG00D", userId: "user-over" }), {
      ok: false,
      reason: "邀请码使用次数已达上限",
      field: "inviteCode",
    });

    releaseInviteCodeUseForUser(db, "user-99");
    assert.deepStrictEqual(consumeInviteCodeInTransaction(db, { code: "KIKIG00D", userId: "user-after-release" }), {
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

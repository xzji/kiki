import { randomBytes } from "crypto";

import { getRegistryDatabase } from "@/lib/server/db/registryClient";

const INVITE_CODE_LENGTH = 8;
const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const INITIAL_MULTI_USE_INVITE_CODES = [{ code: "KIKIG00D", maxUses: 100 }];

export function normalizeInviteCode(code: string) {
  return code.trim().toUpperCase();
}

export function isValidInviteCodeFormat(code: string) {
  return /^[A-Z0-9]{8}$/.test(normalizeInviteCode(code));
}

function nowIso() {
  return new Date().toISOString();
}

function generateOneInviteCode() {
  while (true) {
    const bytes = randomBytes(INVITE_CODE_LENGTH);
    let code = "";
    for (let i = 0; i < INVITE_CODE_LENGTH; i += 1) {
      code += INVITE_ALPHABET[bytes[i]! % INVITE_ALPHABET.length];
    }
    if (isValidInviteCodeFormat(code)) return code;
  }
}

export function createInviteCodes(count: number) {
  const db = getRegistryDatabase();
  const createdAt = nowIso();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO invite_codes (code, created_at, used_at, used_by_user_id, max_uses, usage_count) VALUES (?, ?, NULL, NULL, 1, 0)`,
  );
  const codes: string[] = [];
  const create = db.transaction((targetCount: number) => {
    let attempts = 0;
    while (codes.length < targetCount && attempts < targetCount * 20) {
      attempts += 1;
      const code = generateOneInviteCode();
      const result = insert.run(code, createdAt);
      if (result.changes > 0) codes.push(code);
    }
  });
  create(count);
  if (codes.length < count) {
    throw new Error(`仅成功生成 ${codes.length}/${count} 个邀请码，请重试`);
  }
  return codes;
}

export function seedInviteCodesFromEnv(database?: ReturnType<typeof getRegistryDatabase>) {
  const raw = process.env.KIKI_SEED_INVITE_CODES?.trim();
  const db = database ?? getRegistryDatabase();
  const createdAt = nowIso();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO invite_codes (code, created_at, used_at, used_by_user_id, max_uses, usage_count) VALUES (?, ?, NULL, NULL, ?, 0)`,
  );
  const upgradeMaxUses = db.prepare(
    `
      UPDATE invite_codes
      SET max_uses = CASE WHEN max_uses < ? THEN ? ELSE max_uses END
      WHERE code = ?
    `,
  );
  const seeded: string[] = [];
  const seedCode = (code: string, maxUses: number) => {
    const result = insert.run(code, createdAt, maxUses);
    upgradeMaxUses.run(maxUses, maxUses, code);
    if (result.changes > 0) seeded.push(code);
  };

  for (const inviteCode of INITIAL_MULTI_USE_INVITE_CODES) {
    seedCode(inviteCode.code, inviteCode.maxUses);
  }

  for (const part of raw ? raw.split(/[,\s]+/) : []) {
    const code = normalizeInviteCode(part);
    if (!isValidInviteCodeFormat(code)) continue;
    seedCode(code, INITIAL_MULTI_USE_INVITE_CODES.find((inviteCode) => inviteCode.code === code)?.maxUses ?? 1);
  }
  return seeded;
}

export function consumeInviteCodeInTransaction(
  db: ReturnType<typeof getRegistryDatabase>,
  input: { code: string; userId: string },
) {
  const normalized = normalizeInviteCode(input.code);
  if (!isValidInviteCodeFormat(normalized)) {
    return { ok: false as const, reason: "邀请码须为 8 位字母或数字组合", field: "inviteCode" as const };
  }
  const row = db
    .prepare(`SELECT code, max_uses, usage_count FROM invite_codes WHERE code = ? LIMIT 1`)
    .get(normalized) as { code: string; max_uses: number; usage_count: number } | undefined;
  if (!row) {
    return { ok: false as const, reason: "邀请码无效或不存在", field: "inviteCode" as const };
  }
  if (row.usage_count >= row.max_uses) {
    const reason = row.max_uses <= 1 ? "邀请码已被使用" : "邀请码使用次数已达上限";
    return { ok: false as const, reason, field: "inviteCode" as const };
  }
  const usedAt = nowIso();
  const result = db
    .prepare(
      `
        UPDATE invite_codes
        SET used_at = ?, used_by_user_id = ?, usage_count = usage_count + 1
        WHERE code = ? AND usage_count < max_uses
      `,
    )
    .run(usedAt, input.userId, normalized);
  if (result.changes === 0) {
    return { ok: false as const, reason: "邀请码使用次数已达上限", field: "inviteCode" as const };
  }
  db.prepare(
    `
      INSERT INTO invite_code_redemptions (code, user_id, used_at)
      VALUES (?, ?, ?)
    `,
  ).run(normalized, input.userId, usedAt);
  return { ok: true as const };
}

export function releaseInviteCodeUseForUser(
  db: ReturnType<typeof getRegistryDatabase>,
  userId: string,
) {
  const redemption = db
    .prepare(
      `
        SELECT code
        FROM invite_code_redemptions
        WHERE user_id = ?
        ORDER BY used_at DESC
        LIMIT 1
      `,
    )
    .get(userId) as { code: string } | undefined;
  if (!redemption) {
    db.prepare(`UPDATE invite_codes SET used_at = NULL, used_by_user_id = NULL, usage_count = 0 WHERE used_by_user_id = ?`).run(
      userId,
    );
    return;
  }
  const deleted = db.prepare(`DELETE FROM invite_code_redemptions WHERE code = ? AND user_id = ?`).run(
    redemption.code,
    userId,
  );
  if (deleted.changes === 0) return;
  db.prepare(
    `
      UPDATE invite_codes
      SET
        usage_count = CASE WHEN usage_count > 0 THEN usage_count - 1 ELSE 0 END,
        used_at = CASE WHEN usage_count <= 1 THEN NULL ELSE used_at END,
        used_by_user_id = CASE WHEN used_by_user_id = ? THEN NULL ELSE used_by_user_id END
      WHERE code = ?
    `,
  ).run(userId, redemption.code);
}

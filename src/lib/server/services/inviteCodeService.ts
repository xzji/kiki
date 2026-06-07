import { randomBytes } from "crypto";

import { getRegistryDatabase } from "@/lib/server/db/registryClient";

const INVITE_CODE_LENGTH = 8;
const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function normalizeInviteCode(code: string) {
  return code.trim().toUpperCase();
}

export function isValidInviteCodeFormat(code: string) {
  if (!/^[A-Z0-9]{8}$/.test(code)) return false;
  return /[A-Z]/.test(code) && /[0-9]/.test(code);
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
    `INSERT OR IGNORE INTO invite_codes (code, created_at, used_at, used_by_user_id) VALUES (?, ?, NULL, NULL)`,
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
  if (!raw) return [];
  const db = database ?? getRegistryDatabase();
  const createdAt = nowIso();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO invite_codes (code, created_at, used_at, used_by_user_id) VALUES (?, ?, NULL, NULL)`,
  );
  const seeded: string[] = [];
  for (const part of raw.split(/[,\s]+/)) {
    const code = normalizeInviteCode(part);
    if (!isValidInviteCodeFormat(code)) continue;
    const result = insert.run(code, createdAt);
    if (result.changes > 0) seeded.push(code);
  }
  return seeded;
}

export function consumeInviteCodeInTransaction(
  db: ReturnType<typeof getRegistryDatabase>,
  input: { code: string; userId: string },
) {
  const normalized = normalizeInviteCode(input.code);
  if (!isValidInviteCodeFormat(normalized)) {
    return { ok: false as const, reason: "邀请码须为 8 位字母与数字组合", field: "inviteCode" as const };
  }
  const row = db
    .prepare(`SELECT code, used_at FROM invite_codes WHERE code = ? LIMIT 1`)
    .get(normalized) as { code: string; used_at: string | null } | undefined;
  if (!row) {
    return { ok: false as const, reason: "邀请码无效或不存在", field: "inviteCode" as const };
  }
  if (row.used_at) {
    return { ok: false as const, reason: "邀请码已被使用", field: "inviteCode" as const };
  }
  const usedAt = nowIso();
  const result = db
    .prepare(
      `
        UPDATE invite_codes
        SET used_at = ?, used_by_user_id = ?
        WHERE code = ? AND used_at IS NULL
      `,
    )
    .run(usedAt, input.userId, normalized);
  if (result.changes === 0) {
    return { ok: false as const, reason: "邀请码已被使用", field: "inviteCode" as const };
  }
  return { ok: true as const };
}

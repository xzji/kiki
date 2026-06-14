import { createHash, randomBytes, scryptSync, timingSafeEqual } from "crypto";

import { SESSION_COOKIE_NAME, SESSION_RENEW_INTERVAL_MS, SESSION_TTL_DAYS } from "@/lib/server/auth/authConfig";
import { getRegistryDatabase } from "@/lib/server/db/registryClient";
import {
  consumeInviteCodeInTransaction,
  releaseInviteCodeUseForUser,
} from "@/lib/server/services/inviteCodeService";
import { createOpaqueUserId, provisionUserWorkspace } from "@/lib/server/services/userProvisioning";

const SCRYPT_KEYLEN = 64;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1 };

export type PublicUser = {
  id: string;
  email: string;
  displayName: string;
};

type UserRow = {
  id: string;
  email: string;
  password_hash: string;
  password_salt: string;
  display_name: string;
  status: string;
};

function nowIso() {
  return new Date().toISOString();
}

function addDays(days: number) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function hashPassword(password: string, salt: string) {
  return scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_OPTIONS).toString("hex");
}

function hashSessionToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function verifyPassword(password: string, row: UserRow) {
  const derived = hashPassword(password, row.password_salt);
  const a = Buffer.from(derived, "hex");
  const b = Buffer.from(row.password_hash, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function toPublicUser(row: Pick<UserRow, "id" | "email" | "display_name">): PublicUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
  };
}

function displayNameFromEmail(email: string) {
  const local = email.split("@")[0]?.trim();
  return local || email;
}

export function validateRegisterInput(input: {
  email: string;
  password: string;
  confirmPassword: string;
  displayName?: string;
}) {
  const email = normalizeEmail(input.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false as const, reason: "邮箱格式不正确" };
  }
  if (input.password.length < 8 || !/[A-Za-z]/.test(input.password) || !/\d/.test(input.password)) {
    return { ok: false as const, reason: "密码至少 8 位且包含字母和数字" };
  }
  if (input.password !== input.confirmPassword) {
    return { ok: false as const, reason: "两次输入的密码不一致" };
  }
  const displayName = input.displayName?.trim() || displayNameFromEmail(email);
  if (displayName.length > 30) {
    return { ok: false as const, reason: "昵称不能超过 30 字" };
  }
  return { ok: true as const, email, displayName };
}

function validateDisplayName(displayName: string) {
  const normalized = displayName.trim();
  if (!normalized) {
    return { ok: false as const, reason: "昵称不能为空" };
  }
  if (normalized.length > 30) {
    return { ok: false as const, reason: "昵称不能超过 30 字" };
  }
  return { ok: true as const, displayName: normalized };
}

function validatePasswordFormat(password: string) {
  if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return { ok: false as const, reason: "密码至少 8 位且包含字母和数字" };
  }
  return { ok: true as const };
}

export type AuthSession = {
  token: string;
  user: PublicUser;
  expiresAt: string;
};

export function createSessionForUser(userId: string): AuthSession {
  const db = getRegistryDatabase();
  const user = db
    .prepare(`SELECT id, email, display_name FROM users WHERE id = ? AND status = 'active' LIMIT 1`)
    .get(userId) as Pick<UserRow, "id" | "email" | "display_name"> | undefined;
  if (!user) {
    throw new Error("用户不存在或已停用");
  }

  const token = randomBytes(32).toString("hex");
  const tokenHash = hashSessionToken(token);
  const createdAt = nowIso();
  const expiresAt = addDays(SESSION_TTL_DAYS);
  db.prepare(
    `
      INSERT INTO sessions (token, user_id, created_at, expires_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?)
    `,
  ).run(tokenHash, user.id, createdAt, expiresAt, createdAt);

  return {
    token,
    user: toPublicUser(user),
    expiresAt,
  };
}

export function registerUser(input: {
  email: string;
  password: string;
  confirmPassword: string;
  displayName?: string;
  inviteCode: string;
}): { ok: true; session: AuthSession } | { ok: false; reason: string; field?: "email" | "inviteCode" } {
  const validated = validateRegisterInput(input);
  if (!validated.ok) {
    return { ok: false, reason: validated.reason };
  }

  const db = getRegistryDatabase();
  const existing = db
    .prepare(`SELECT id FROM users WHERE email = ? LIMIT 1`)
    .get(validated.email) as { id: string } | undefined;
  if (existing) {
    return { ok: false, reason: "该邮箱已被注册，换一个或直接去登录", field: "email" };
  }

  const userId = createOpaqueUserId();
  const salt = randomBytes(16).toString("hex");
  const passwordHash = hashPassword(input.password, salt);
  const timestamp = nowIso();

  const registerTx = db.transaction(() => {
    const inviteResult = consumeInviteCodeInTransaction(db, {
      code: input.inviteCode,
      userId,
    });
    if (!inviteResult.ok) return inviteResult;

    db.prepare(
      `
        INSERT INTO users (id, email, password_hash, password_salt, display_name, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
      `,
    ).run(userId, validated.email, passwordHash, salt, validated.displayName, timestamp, timestamp);
    return { ok: true as const };
  });

  const txResult = registerTx();
  if (!txResult.ok) {
    return txResult;
  }

  try {
    provisionUserWorkspace(userId);
  } catch (error) {
    db.prepare(`DELETE FROM users WHERE id = ?`).run(userId);
    releaseInviteCodeUseForUser(db, userId);
    const message = error instanceof Error ? error.message : "用户工作区初始化失败";
    return { ok: false, reason: message };
  }

  const session = createSessionForUser(userId);
  return { ok: true, session };
}

export function loginUser(input: {
  email: string;
  password: string;
}): { ok: true; session: AuthSession } | { ok: false; reason: string } {
  const email = normalizeEmail(input.email);
  const db = getRegistryDatabase();
  const user = db
    .prepare(
      `
        SELECT id, email, password_hash, password_salt, display_name, status
        FROM users
        WHERE email = ? AND status = 'active'
        LIMIT 1
      `,
    )
    .get(email) as UserRow | undefined;
  if (!user || !verifyPassword(input.password, user)) {
    return { ok: false, reason: "邮箱或密码不正确" };
  }
  const session = createSessionForUser(user.id);
  return { ok: true, session };
}

export function updateUserDisplayName(input: {
  userId: string;
  displayName: string;
}): { ok: true; user: PublicUser } | { ok: false; reason: string } {
  const validated = validateDisplayName(input.displayName);
  if (!validated.ok) {
    return { ok: false, reason: validated.reason };
  }

  const db = getRegistryDatabase();
  const timestamp = nowIso();
  const result = db
    .prepare(
      `
        UPDATE users
        SET display_name = ?, updated_at = ?
        WHERE id = ? AND status = 'active'
      `,
    )
    .run(validated.displayName, timestamp, input.userId);
  if (result.changes !== 1) {
    return { ok: false, reason: "用户不存在或已停用" };
  }

  const row = db
    .prepare(`SELECT id, email, display_name FROM users WHERE id = ? AND status = 'active' LIMIT 1`)
    .get(input.userId) as Pick<UserRow, "id" | "email" | "display_name"> | undefined;
  if (!row) {
    return { ok: false, reason: "用户不存在或已停用" };
  }
  return { ok: true, user: toPublicUser(row) };
}

export function changeUserPassword(input: {
  userId: string;
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}): { ok: true } | { ok: false; reason: string; field?: "currentPassword" | "newPassword" | "confirmPassword" } {
  if (!input.currentPassword) {
    return { ok: false, reason: "请输入当前密码", field: "currentPassword" };
  }
  const passwordFormat = validatePasswordFormat(input.newPassword);
  if (!passwordFormat.ok) {
    return { ok: false, reason: passwordFormat.reason, field: "newPassword" };
  }
  if (input.newPassword !== input.confirmPassword) {
    return { ok: false, reason: "两次输入的新密码不一致", field: "confirmPassword" };
  }

  const db = getRegistryDatabase();
  const user = db
    .prepare(
      `
        SELECT id, email, password_hash, password_salt, display_name, status
        FROM users
        WHERE id = ? AND status = 'active'
        LIMIT 1
      `,
    )
    .get(input.userId) as UserRow | undefined;
  if (!user) {
    return { ok: false, reason: "用户不存在或已停用" };
  }
  if (!verifyPassword(input.currentPassword, user)) {
    return { ok: false, reason: "当前密码不正确", field: "currentPassword" };
  }
  if (verifyPassword(input.newPassword, user)) {
    return { ok: false, reason: "新密码不能和当前密码相同", field: "newPassword" };
  }

  const salt = randomBytes(16).toString("hex");
  const passwordHash = hashPassword(input.newPassword, salt);
  db.prepare(
    `
      UPDATE users
      SET password_hash = ?, password_salt = ?, updated_at = ?
      WHERE id = ? AND status = 'active'
    `,
  ).run(passwordHash, salt, nowIso(), input.userId);

  return { ok: true };
}

export function resolveSessionFromToken(token: string | null | undefined): PublicUser | null {
  if (!token?.trim()) return null;
  const db = getRegistryDatabase();
  const tokenHash = hashSessionToken(token.trim());
  const row = db
    .prepare(
      `
        SELECT s.expires_at, s.last_seen_at, u.id, u.email, u.display_name
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token = ? AND u.status = 'active'
        LIMIT 1
      `,
    )
    .get(tokenHash) as
    | {
        expires_at: string;
        last_seen_at: string;
        id: string;
        email: string;
        display_name: string;
      }
    | undefined;
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    db.prepare(`DELETE FROM sessions WHERE token = ?`).run(tokenHash);
    return null;
  }

  const shouldRenew =
    Date.now() - new Date(row.last_seen_at).getTime() >= SESSION_RENEW_INTERVAL_MS;
  if (shouldRenew) {
    const nextExpiresAt = addDays(SESSION_TTL_DAYS);
    db.prepare(
      `
        UPDATE sessions
        SET last_seen_at = ?, expires_at = ?
        WHERE token = ?
      `,
    ).run(nowIso(), nextExpiresAt, tokenHash);
  }

  return toPublicUser(row);
}

export function logoutSession(token: string | null | undefined) {
  if (!token?.trim()) return;
  const db = getRegistryDatabase();
  db.prepare(`DELETE FROM sessions WHERE token = ?`).run(hashSessionToken(token.trim()));
}

export function buildSessionCookie(token: string, expiresAt: string) {
  const secure = process.env.NODE_ENV === "production";
  const parts = [
    `${SESSION_COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Expires=${new Date(expiresAt).toUTCString()}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie() {
  const secure = process.env.NODE_ENV === "production";
  const parts = [`${SESSION_COOKIE_NAME}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

#!/usr/bin/env node

import { createInviteCodes, isValidInviteCodeFormat, normalizeInviteCode } from "@/lib/server/services/inviteCodeService";
import { getRegistryDatabase } from "@/lib/server/db/registryClient";

function readCountArg() {
  const positional = process.argv.slice(2).find((arg) => /^\d+$/.test(arg));
  return positional ? Number(positional) : 1;
}

function readExplicitCodes() {
  const flagIndex = process.argv.indexOf("--codes");
  if (flagIndex < 0) return [];
  const value = process.argv[flagIndex + 1];
  if (!value) return [];
  return value.split(/[,\s]+/).map((part) => normalizeInviteCode(part)).filter(Boolean);
}

async function main() {
  getRegistryDatabase();

  const explicit = readExplicitCodes();
  if (explicit.length > 0) {
    const invalid = explicit.filter((code) => !isValidInviteCodeFormat(code));
    if (invalid.length > 0) {
      console.error(`无效邀请码（须 8 位字母数字混排）：${invalid.join(", ")}`);
      process.exitCode = 1;
      return;
    }
    const db = getRegistryDatabase();
    const createdAt = new Date().toISOString();
    const insert = db.prepare(
      `INSERT OR IGNORE INTO invite_codes (code, created_at, used_at, used_by_user_id) VALUES (?, ?, NULL, NULL)`,
    );
    const created: string[] = [];
    for (const code of explicit) {
      const result = insert.run(code, createdAt);
      if (result.changes > 0) created.push(code);
    }
    console.log(created.length > 0 ? created.join("\n") : "（均已存在，未新增）");
    return;
  }

  const count = readCountArg();
  const codes = createInviteCodes(count);
  console.log(codes.join("\n"));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

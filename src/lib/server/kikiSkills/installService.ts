import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

import { BUNDLED_KIKI_SKILLS } from "@/lib/kikiSkills/bundledSkills";
import type {
  BundledKikiSkill,
  KikiSkillStatusItem,
  KikiSkillsInstallPayload,
  KikiSkillsStatusPayload,
} from "@/lib/kikiSkills/types";

const MANAGED_BY = "kiki";
const META_FILENAME = ".kiki-skill.json";
const CLAUDE_SKILLS_DIR_ENV = "KIKI_CLAUDE_SKILLS_DIR";

type ManagedSkillMeta = {
  managedBy: string;
  sourceSkillId: string;
  targetName: string;
  version: string;
  contentHash: string;
  installedAt: string;
};

function resolveClaudeSkillsDir() {
  const configured = process.env[CLAUDE_SKILLS_DIR_ENV]?.trim();
  return path.resolve(configured || path.join(os.homedir(), ".claude", "skills"));
}

function assertSafeRelativePath(relativePath: string) {
  const normalized = path.posix.normalize(relativePath.replaceAll("\\", "/"));
  if (
    !relativePath.trim() ||
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error(`KiKi skill 文件路径非法：${relativePath}`);
  }
  return normalized;
}

function assertSafeTargetName(targetName: string) {
  if (!/^kiki-[a-z0-9][a-z0-9-]*$/.test(targetName)) {
    throw new Error(`KiKi skill 目标目录名非法：${targetName}`);
  }
}

function validateSkill(skill: BundledKikiSkill) {
  if (!skill.id.trim()) throw new Error("KiKi skill 缺少 id");
  assertSafeTargetName(skill.targetName);
  if (!skill.files.some((file) => assertSafeRelativePath(file.relativePath) === "SKILL.md")) {
    throw new Error(`KiKi skill ${skill.id} 缺少 SKILL.md`);
  }
  for (const file of skill.files) {
    assertSafeRelativePath(file.relativePath);
  }
}

function getValidatedSkills() {
  const seen = new Set<string>();
  for (const skill of BUNDLED_KIKI_SKILLS) {
    validateSkill(skill);
    if (seen.has(skill.id)) throw new Error(`KiKi skill id 重复：${skill.id}`);
    seen.add(skill.id);
  }
  return BUNDLED_KIKI_SKILLS;
}

function computeSkillHash(skill: BundledKikiSkill) {
  const hash = crypto.createHash("sha256");
  hash.update(`id:${skill.id}\n`);
  hash.update(`version:${skill.version}\n`);
  for (const file of [...skill.files].sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    const relativePath = assertSafeRelativePath(file.relativePath);
    hash.update(`file:${relativePath}\n`);
    hash.update(file.content);
    hash.update("\n");
  }
  return `sha256:${hash.digest("hex")}`;
}

function readManagedMeta(targetPath: string): ManagedSkillMeta | null {
  try {
    const raw = fs.readFileSync(path.join(targetPath, META_FILENAME), "utf8");
    const parsed = JSON.parse(raw) as Partial<ManagedSkillMeta>;
    if (
      parsed.managedBy === MANAGED_BY &&
      typeof parsed.sourceSkillId === "string" &&
      typeof parsed.targetName === "string" &&
      typeof parsed.version === "string" &&
      typeof parsed.contentHash === "string"
    ) {
      return parsed as ManagedSkillMeta;
    }
    return null;
  } catch {
    return null;
  }
}

function statusForSkill(skill: BundledKikiSkill, targetRoot: string): KikiSkillStatusItem {
  const contentHash = computeSkillHash(skill);
  const targetPath = path.join(targetRoot, skill.targetName);
  if (!fs.existsSync(targetPath)) {
    return {
      sourceSkillId: skill.id,
      targetName: skill.targetName,
      version: skill.version,
      contentHash,
      status: "not_installed",
      targetPath,
    };
  }

  const stat = fs.lstatSync(targetPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    return {
      sourceSkillId: skill.id,
      targetName: skill.targetName,
      version: skill.version,
      contentHash,
      status: "blocked",
      targetPath,
      reason: "目标路径已存在但不是 KiKi 管理目录",
    };
  }

  const meta = readManagedMeta(targetPath);
  if (!meta || meta.sourceSkillId !== skill.id || meta.targetName !== skill.targetName) {
    return {
      sourceSkillId: skill.id,
      targetName: skill.targetName,
      version: skill.version,
      contentHash,
      status: "blocked",
      targetPath,
      reason: "目标目录已存在但没有 KiKi 管理标记",
    };
  }

  return {
    sourceSkillId: skill.id,
    targetName: skill.targetName,
    version: skill.version,
    contentHash,
    status: meta.contentHash === contentHash ? "installed" : "outdated",
    targetPath,
  };
}

function buildStatusPayload(targetRoot: string, skills: KikiSkillStatusItem[]): KikiSkillsStatusPayload {
  const installed = skills.filter((skill) => skill.status === "installed").length;
  const outdated = skills.filter((skill) => skill.status === "outdated").length;
  const notInstalled = skills.filter((skill) => skill.status === "not_installed").length;
  const blocked = skills.filter((skill) => skill.status === "blocked").length;
  return {
    ok: true,
    targetRoot,
    skills,
    installed,
    outdated,
    notInstalled,
    blocked,
    message: blocked > 0 ? `发现 ${blocked} 个目录冲突，KiKi 不会覆盖用户自定义 skill。` : undefined,
  };
}

export function getKikiDefaultSkillsStatus(): KikiSkillsStatusPayload {
  const targetRoot = resolveClaudeSkillsDir();
  const skills = getValidatedSkills().map((skill) => statusForSkill(skill, targetRoot));
  return buildStatusPayload(targetRoot, skills);
}

function writeSkillDirectory(input: {
  skill: BundledKikiSkill;
  targetRoot: string;
  contentHash: string;
}) {
  const { skill, targetRoot, contentHash } = input;
  fs.mkdirSync(targetRoot, { recursive: true });
  const targetPath = path.join(targetRoot, skill.targetName);
  const tempPath = fs.mkdtempSync(path.join(targetRoot, `.${skill.targetName}-tmp-`));

  try {
    for (const file of skill.files) {
      const relativePath = assertSafeRelativePath(file.relativePath);
      const filePath = path.join(tempPath, relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, file.content, "utf8");
    }
    const meta: ManagedSkillMeta = {
      managedBy: MANAGED_BY,
      sourceSkillId: skill.id,
      targetName: skill.targetName,
      version: skill.version,
      contentHash,
      installedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(tempPath, META_FILENAME), `${JSON.stringify(meta, null, 2)}\n`, "utf8");

    if (fs.existsSync(targetPath)) {
      const currentStat = fs.lstatSync(targetPath);
      const currentMeta = currentStat.isDirectory() && !currentStat.isSymbolicLink()
        ? readManagedMeta(targetPath)
        : null;
      if (!currentMeta || currentMeta.sourceSkillId !== skill.id || currentMeta.targetName !== skill.targetName) {
        throw new Error(`目标目录 ${targetPath} 已存在但不是 KiKi 管理副本，已停止安装以避免覆盖用户 skill`);
      }
      fs.rmSync(targetPath, { recursive: true, force: true });
    }
    fs.renameSync(tempPath, targetPath);
  } catch (error) {
    fs.rmSync(tempPath, { recursive: true, force: true });
    throw error;
  }
}

export function installKikiDefaultSkills(): KikiSkillsInstallPayload {
  const before = getKikiDefaultSkillsStatus();
  let installedNow = 0;
  let updatedNow = 0;
  let skipped = 0;

  for (const item of before.skills) {
    const skill = BUNDLED_KIKI_SKILLS.find((candidate) => candidate.id === item.sourceSkillId);
    if (!skill) continue;
    if (item.status === "blocked") {
      skipped += 1;
      continue;
    }
    if (item.status === "installed") {
      skipped += 1;
      continue;
    }
    writeSkillDirectory({
      skill,
      targetRoot: before.targetRoot,
      contentHash: item.contentHash,
    });
    if (item.status === "not_installed") installedNow += 1;
    if (item.status === "outdated") updatedNow += 1;
  }

  const after = getKikiDefaultSkillsStatus();
  return {
    ...after,
    installedNow,
    updatedNow,
    skipped,
    message:
      after.blocked > 0
        ? `已安装 ${installedNow} 个，更新 ${updatedNow} 个，跳过 ${skipped} 个；另有 ${after.blocked} 个目录冲突。`
        : `已安装 ${installedNow} 个，更新 ${updatedNow} 个，跳过 ${skipped} 个。`,
  };
}

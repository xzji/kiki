export type BundledKikiSkillFile = {
  relativePath: string;
  content: string;
};

export type BundledKikiSkill = {
  id: string;
  targetName: string;
  version: string;
  files: BundledKikiSkillFile[];
};

export type KikiSkillInstallStatus =
  | "not_installed"
  | "installed"
  | "outdated"
  | "blocked";

export type KikiSkillStatusItem = {
  sourceSkillId: string;
  targetName: string;
  version: string;
  contentHash: string;
  status: KikiSkillInstallStatus;
  targetPath: string;
  reason?: string;
};

export type KikiSkillsStatusPayload = {
  ok: boolean;
  targetRoot: string;
  skills: KikiSkillStatusItem[];
  installed: number;
  outdated: number;
  notInstalled: number;
  blocked: number;
  message?: string;
};

export type KikiSkillsInstallPayload = KikiSkillsStatusPayload & {
  installedNow: number;
  updatedNow: number;
  skipped: number;
};

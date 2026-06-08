import type {
  KikiSkillsInstallPayload,
  KikiSkillsStatusPayload,
} from "@/lib/kikiSkills/types";

export type {
  KikiSkillInstallStatus,
  KikiSkillStatusItem,
  KikiSkillsInstallPayload,
  KikiSkillsStatusPayload,
} from "@/lib/kikiSkills/types";

async function readSkillsResponse<T extends { ok: boolean; message?: string }>(
  response: Response,
  fallback: string,
): Promise<T> {
  const payload = (await response.json().catch(() => ({ ok: false, message: fallback }))) as T;
  if (!response.ok || !payload.ok) {
    throw new Error(payload.message || fallback);
  }
  return payload;
}

export async function fetchKikiSkillsStatus(): Promise<KikiSkillsStatusPayload> {
  const response = await fetch("/api/runtime/skills/status", { cache: "no-store" });
  return readSkillsResponse<KikiSkillsStatusPayload>(response, "KiKi 默认 skills 状态获取失败");
}

export async function installKikiDefaultSkills(): Promise<KikiSkillsInstallPayload> {
  const response = await fetch("/api/runtime/skills/install", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
  });
  return readSkillsResponse<KikiSkillsInstallPayload>(response, "KiKi 默认 skills 安装失败");
}

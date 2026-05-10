import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

import { getLaunchAgentPlistPath, getRuntimeLogsDir } from "@/lib/server/storage/paths";

const TEMPLATE_PATH = path.resolve(process.cwd(), "packaging/macos/com.kiki.runtime-daemon.plist");
const execFileAsync = promisify(execFile);
const LAUNCH_AGENT_LABEL = "com.kiki.runtime-daemon";

export function installLaunchAgentTemplate() {
  const template = fs.readFileSync(TEMPLATE_PATH, "utf8");
  const content = template
    .replaceAll("__PROJECT_ROOT__", process.cwd())
    .replaceAll("__RUNTIME_LOG_DIR__", getRuntimeLogsDir());
  const targetPath = getLaunchAgentPlistPath();
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content, "utf8");
  return targetPath;
}

export function isLaunchAgentInstalled() {
  return fs.existsSync(getLaunchAgentPlistPath());
}

export async function installAndLoadLaunchAgent() {
  if (process.platform !== "darwin") {
    throw new Error("当前仅支持在 macOS 上安装 LaunchAgent");
  }

  const targetPath = installLaunchAgentTemplate();
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : null;

  if (!uid) {
    throw new Error("无法识别当前用户，暂时不能安装 LaunchAgent");
  }

  const domain = `gui/${uid}`;
  await execFileAsync("launchctl", ["bootout", domain, targetPath]).catch(() => undefined);
  await execFileAsync("launchctl", ["bootstrap", domain, targetPath]);
  await execFileAsync("launchctl", ["kickstart", "-k", `${domain}/${LAUNCH_AGENT_LABEL}`]);

  return targetPath;
}

export async function unloadAndRemoveLaunchAgent() {
  if (process.platform !== "darwin") {
    throw new Error("当前仅支持在 macOS 上管理 LaunchAgent");
  }

  const targetPath = getLaunchAgentPlistPath();
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : null;

  if (!uid) {
    throw new Error("无法识别当前用户，暂时不能关闭 LaunchAgent");
  }

  if (!fs.existsSync(targetPath)) {
    return targetPath;
  }

  const domain = `gui/${uid}`;
  await execFileAsync("launchctl", ["bootout", domain, targetPath]).catch(() => undefined);
  fs.unlinkSync(targetPath);
  return targetPath;
}

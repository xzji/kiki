import fs from "fs";
import os from "os";
import path from "path";
import { execFile, execFileSync } from "child_process";
import { promisify } from "util";

import { collectDaemonServiceEnv } from "./pathEnv";

const execFileAsync = promisify(execFile);

const MAC_LABEL = "com.kiki.daemon";
const LINUX_UNIT = "kiki-daemon.service";

export type InstallContext = {
  /** node 可执行文件绝对路径 */
  nodePath: string;
  /** 已安装的 cli 入口脚本绝对路径 */
  scriptPath: string;
  serverUrl: string;
  apiKey: string;
  /** 安装时捕获的完整环境变量；未提供则用当前 process.env 生成 */
  environment?: Record<string, string>;
};

/** install 时写入 plist/unit 的脚本路径；若通过 npx 调用但已全局安装，优先用全局路径。 */
export function resolveInstallScriptPath(entryPath = process.argv[1] || __filename) {
  const current = fs.realpathSync(entryPath);
  if (!current.includes(`${path.sep}_npx${path.sep}`)) {
    return current;
  }
  try {
    const bin = execFileSync("which", ["kiki-daemon"], { encoding: "utf8" }).trim();
    if (bin && !bin.includes("_npx")) {
      return fs.realpathSync(bin);
    }
  } catch {
    // ignore
  }
  return current;
}

function kikiHome() {
  return path.join(os.homedir(), ".kiki");
}

function logsDir() {
  const dir = path.join(kikiHome(), "runtime", "logs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 后台服务固定使用 ~/.kiki/data，避免 cwd 漂移到 `/` 导致写到 /data */
function dataDir() {
  const dir = path.join(kikiHome(), "data");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function macPlistPath() {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${MAC_LABEL}.plist`);
}

function linuxUnitPath() {
  return path.join(os.homedir(), ".config", "systemd", "user", LINUX_UNIT);
}

function xmlEscape(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function resolveServiceEnvironment(ctx: InstallContext) {
  const base = ctx.environment ?? collectDaemonServiceEnv(process.env);
  return {
    ...base,
    KIKI_DATA_DIR: dataDir(),
    HOME: base.HOME || os.homedir(),
  };
}

function buildMacPlist(ctx: InstallContext) {
  const serviceEnv = resolveServiceEnvironment(ctx);
  const envXml = Object.entries(serviceEnv)
    .map(([key, value]) => `      <key>${xmlEscape(key)}</key>\n      <string>${xmlEscape(value)}</string>`)
    .join("\n");

  const args = [
    ctx.nodePath,
    ctx.scriptPath,
    "run",
    "--server-url",
    ctx.serverUrl,
    "--api-key",
    ctx.apiKey,
  ];
  const argXml = args.map((arg) => `      <string>${xmlEscape(arg)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${MAC_LABEL}</string>

    <key>ProgramArguments</key>
    <array>
${argXml}
    </array>

    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>${xmlEscape(path.join(logsDir(), "daemon.stdout.log"))}</string>

    <key>StandardErrorPath</key>
    <string>${xmlEscape(path.join(logsDir(), "daemon.stderr.log"))}</string>
  </dict>
</plist>
`;
}

function buildLinuxUnit(ctx: InstallContext) {
  const escape = (value: string) => value.replaceAll("%", "%%");
  const serviceEnv = resolveServiceEnvironment(ctx);
  const envLines = Object.entries(serviceEnv)
    .map(([key, value]) => `Environment=${key}=${escape(value)}`)
    .join("\n");
  const execStart = [ctx.nodePath, ctx.scriptPath, "run", "--server-url", ctx.serverUrl, "--api-key", ctx.apiKey]
    .map((part) => `'${part.replaceAll("'", "'\\''")}'`)
    .join(" ");
  return `[Unit]
Description=Kiki local execution daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
${envLines}
ExecStart=${execStart}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

async function uid() {
  return typeof process.getuid === "function" ? String(process.getuid()) : null;
}

export async function installService(ctx: InstallContext) {
  if (process.platform === "darwin") {
    const target = macPlistPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buildMacPlist(ctx), "utf8");
    const id = await uid();
    if (!id) throw new Error("无法识别当前用户，无法安装 LaunchAgent");
    const domain = `gui/${id}`;
    await execFileAsync("launchctl", ["bootout", domain, target]).catch(() => undefined);
    await execFileAsync("launchctl", ["bootstrap", domain, target]);
    await execFileAsync("launchctl", ["kickstart", "-k", `${domain}/${MAC_LABEL}`]);
    return { kind: "launchd" as const, path: target };
  }

  if (process.platform === "linux") {
    const target = linuxUnitPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buildLinuxUnit(ctx), "utf8");
    await execFileAsync("systemctl", ["--user", "daemon-reload"]);
    await execFileAsync("systemctl", ["--user", "enable", "--now", LINUX_UNIT]);
    // 让服务在用户未登录时也能运行（开机自启）
    await execFileAsync("loginctl", ["enable-linger", os.userInfo().username]).catch(() => undefined);
    return { kind: "systemd" as const, path: target };
  }

  throw new Error(
    `当前平台 ${process.platform} 暂不支持自动安装后台服务，请手动用任务计划/NSSM 注册：\n  ${ctx.nodePath} ${ctx.scriptPath} run --server-url ${ctx.serverUrl} --api-key <key>`,
  );
}

export async function uninstallService() {
  if (process.platform === "darwin") {
    const target = macPlistPath();
    const id = await uid();
    if (id && fs.existsSync(target)) {
      await execFileAsync("launchctl", ["bootout", `gui/${id}`, target]).catch(() => undefined);
    }
    if (fs.existsSync(target)) fs.unlinkSync(target);
    return { kind: "launchd" as const, path: target };
  }

  if (process.platform === "linux") {
    const target = linuxUnitPath();
    await execFileAsync("systemctl", ["--user", "disable", "--now", LINUX_UNIT]).catch(() => undefined);
    if (fs.existsSync(target)) fs.unlinkSync(target);
    await execFileAsync("systemctl", ["--user", "daemon-reload"]).catch(() => undefined);
    return { kind: "systemd" as const, path: target };
  }

  throw new Error(`当前平台 ${process.platform} 暂不支持自动卸载后台服务`);
}

export async function serviceStatus() {
  if (process.platform === "darwin") {
    const target = macPlistPath();
    const installed = fs.existsSync(target);
    let running = false;
    if (installed) {
      const id = await uid();
      if (id) {
        const result = await execFileAsync("launchctl", ["print", `gui/${id}/${MAC_LABEL}`]).catch(() => null);
        running = Boolean(result && /state = running/.test(result.stdout));
      }
    }
    return { kind: "launchd" as const, installed, running, path: target };
  }

  if (process.platform === "linux") {
    const target = linuxUnitPath();
    const installed = fs.existsSync(target);
    const result = await execFileAsync("systemctl", ["--user", "is-active", LINUX_UNIT]).catch((error) => error);
    const running = Boolean(result && typeof result.stdout === "string" && result.stdout.trim() === "active");
    return { kind: "systemd" as const, installed, running, path: target };
  }

  return { kind: "unsupported" as const, installed: false, running: false, path: "" };
}

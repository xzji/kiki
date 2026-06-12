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

function runtimeDir() {
  const dir = path.join(kikiHome(), "runtime");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function daemonProcessStatePath() {
  return path.join(runtimeDir(), "daemon-process.json");
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

function xmlUnescape(value: string) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function resolveServiceEnvironment(ctx: InstallContext) {
  const base = ctx.environment ?? collectDaemonServiceEnv(process.env);
  return {
    ...base,
    KIKI_DATA_DIR: dataDir(),
    HOME: base.HOME || os.homedir(),
    // 标记此进程由后台服务（launchd/systemd）托管，使其在收到 autostart 命令时
    // 不会像前台进程那样自我退出，避免误杀常驻服务。
    KIKI_DAEMON_MANAGED: "1",
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
# 关闭崩溃节流：默认 10s 内崩 5 次会进 failed 永久不再拉起，置 0 保证无限重启
StartLimitIntervalSec=0

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

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** 读取 daemon.stderr.log 末尾若干行，用于在启动校验失败时给出真实原因 */
function tailDaemonStderr(maxLines = 12): string {
  try {
    const file = path.join(logsDir(), "daemon.stderr.log");
    if (!fs.existsSync(file)) return "";
    const content = fs.readFileSync(file, "utf8").trimEnd();
    if (!content) return "";
    return content.split("\n").slice(-maxLines).join("\n");
  } catch {
    return "";
  }
}

type DaemonProcessState = {
  pid: number;
  daemonVersion: string;
  startedAt: string;
};

export function writeDaemonProcessState(input: { daemonVersion: string }) {
  const state: DaemonProcessState = {
    pid: process.pid,
    daemonVersion: input.daemonVersion,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(daemonProcessStatePath(), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function readDaemonProcessState(pid: number | null): DaemonProcessState | null {
  if (!pid) return null;
  try {
    const raw = fs.readFileSync(daemonProcessStatePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<DaemonProcessState>;
    if (parsed.pid !== pid || typeof parsed.daemonVersion !== "string") return null;
    return {
      pid,
      daemonVersion: parsed.daemonVersion,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
    };
  } catch {
    return null;
  }
}

function parseLaunchdPid(stdout: string): number | null {
  const match = stdout.match(/(?:^|\n)\s*pid = (\d+)/);
  if (!match) return null;
  const pid = Number.parseInt(match[1], 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function readMacProgramArguments(plistPath: string): string[] {
  try {
    const content = fs.readFileSync(plistPath, "utf8");
    const arrayMatch = content.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
    if (!arrayMatch) return [];
    const args: string[] = [];
    const stringPattern = /<string>([\s\S]*?)<\/string>/g;
    let match: RegExpExecArray | null = stringPattern.exec(arrayMatch[1]);
    while (match) {
      args.push(xmlUnescape(match[1]));
      match = stringPattern.exec(arrayMatch[1]);
    }
    return args;
  } catch {
    return [];
  }
}

function readLinuxExecStart(unitPath: string): string[] {
  try {
    const content = fs.readFileSync(unitPath, "utf8");
    const line = content
      .split("\n")
      .find((item) => item.startsWith("ExecStart="))
      ?.slice("ExecStart=".length);
    if (!line) return [];
    const args: string[] = [];
    const quotedPattern = /'((?:'\\''|[^'])*)'/g;
    let match: RegExpExecArray | null = quotedPattern.exec(line);
    while (match) {
      args.push(match[1].replaceAll("'\\''", "'"));
      match = quotedPattern.exec(line);
    }
    return args;
  } catch {
    return [];
  }
}

async function readConfiguredDaemonVersion(args: string[]): Promise<string | null> {
  const [nodePath, scriptPath] = args;
  if (!nodePath || !scriptPath) return null;
  const result = await execFileAsync(nodePath, [scriptPath, "version"], { timeout: 3000 }).catch(() => null);
  const stdout = typeof result?.stdout === "string" ? result.stdout.trim() : "";
  const match = stdout.match(/^kiki-daemon\s+(.+)$/);
  return match?.[1]?.trim() || null;
}

/**
 * install 之后轮询 serviceStatus()，确认进程确实稳定 running。
 * launchctl/systemctl 命令退出码为 0 仅代表“登记+拉起一次”，不代表进程能存活；
 * 进程拉起后立刻崩溃（如连不上服务端、脚本路径失效）时命令仍返回成功，
 * 这里通过轮询补上“真·running”校验，失败则抛出带 stderr 末尾的明确错误。
 */
async function verifyServiceRunning(input: { attempts?: number; intervalMs?: number } = {}) {
  const attempts = input.attempts ?? 5;
  const intervalMs = input.intervalMs ?? 800;
  let lastRunning = false;
  for (let i = 0; i < attempts; i += 1) {
    await sleep(intervalMs);
    const status = await serviceStatus();
    lastRunning = status.running;
    if (status.running) return;
  }
  const tail = tailDaemonStderr();
  const detail = tail ? `\n--- daemon.stderr.log（末尾）---\n${tail}` : "";
  throw new Error(
    `后台服务已登记但未稳定运行（running=${lastRunning}）。进程可能在启动后立即退出，` +
      `请检查 server-url/api-key 是否正确、网络是否可达。${detail}`,
  );
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
    await verifyServiceRunning();
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
    await verifyServiceRunning();
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
    let pid: number | null = null;
    if (installed) {
      const id = await uid();
      if (id) {
        const result = await execFileAsync("launchctl", ["print", `gui/${id}/${MAC_LABEL}`]).catch(() => null);
        running = Boolean(result && /state = running/.test(result.stdout));
        pid = result ? parseLaunchdPid(result.stdout) : null;
      }
    }
    const processState = running ? readDaemonProcessState(pid) : null;
    const configuredVersion =
      running && !processState?.daemonVersion ? await readConfiguredDaemonVersion(readMacProgramArguments(target)) : null;
    return {
      kind: "launchd" as const,
      installed,
      running,
      path: target,
      pid,
      daemonVersion: processState?.daemonVersion ?? configuredVersion,
    };
  }

  if (process.platform === "linux") {
    const target = linuxUnitPath();
    const installed = fs.existsSync(target);
    const result = await execFileAsync("systemctl", ["--user", "is-active", LINUX_UNIT]).catch((error) => error);
    const running = Boolean(result && typeof result.stdout === "string" && result.stdout.trim() === "active");
    const pidResult = running
      ? await execFileAsync("systemctl", ["--user", "show", LINUX_UNIT, "--property=MainPID", "--value"]).catch(() => null)
      : null;
    const pidText = pidResult?.stdout?.trim() ?? "";
    const pid = pidText ? Number.parseInt(pidText, 10) : null;
    const normalizedPid = pid && Number.isFinite(pid) && pid > 0 ? pid : null;
    const processState = running ? readDaemonProcessState(normalizedPid) : null;
    const configuredVersion =
      running && !processState?.daemonVersion ? await readConfiguredDaemonVersion(readLinuxExecStart(target)) : null;
    return {
      kind: "systemd" as const,
      installed,
      running,
      path: target,
      pid: normalizedPid,
      daemonVersion: processState?.daemonVersion ?? configuredVersion,
    };
  }

  return { kind: "unsupported" as const, installed: false, running: false, path: "", pid: null, daemonVersion: null };
}

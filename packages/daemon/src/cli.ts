import path from "path";
import { format } from "util";

import { runRemoteDaemonLoop } from "@/lib/daemon/remoteDaemonLoop";
import type { RemoteDaemonServiceStatus } from "@/lib/server/tunnel/tunnelHub";

import packageJson from "../package.json";
import { collectDaemonServiceEnv } from "./pathEnv";
import {
  installService as installDaemonService,
  resolveInstallScriptPath,
  serviceStatus,
  uninstallService as uninstallDaemonService,
  writeDaemonProcessState,
} from "./service";
import { ensureSingleDaemonInstance } from "./singleton";

type Subcommand = "run" | "install" | "uninstall" | "status" | "version" | "help";
const DAEMON_PACKAGE_VERSION = packageJson.version;

function readArg(flag: string): string | undefined {
  const direct = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  if (direct) return direct.slice(flag.length + 1);
  const index = process.argv.indexOf(flag);
  if (index >= 0) return process.argv[index + 1];
  return undefined;
}

function resolveSubcommand(): Subcommand {
  const positional = process.argv.slice(2).find((arg) => !arg.startsWith("-"));
  if (
    positional === "install" ||
    positional === "uninstall" ||
    positional === "status" ||
    positional === "version" ||
    positional === "help"
  ) {
    return positional;
  }
  if (process.argv.includes("--help") || process.argv.includes("-h")) return "help";
  if (process.argv.includes("--version") || process.argv.includes("-v")) return "version";
  return "run";
}

function requireConnectionArgs() {
  const serverUrl = readArg("--server-url");
  const apiKey = readArg("--api-key");
  if (!serverUrl || !apiKey) {
    console.error("缺少参数：需要 --server-url <https://...> 与 --api-key <sk_machine_...>");
    process.exit(1);
  }
  return { serverUrl, apiKey };
}

async function remoteServiceStatus(): Promise<RemoteDaemonServiceStatus> {
  return { platform: process.platform, ...(await serviceStatus()) };
}

function formatLocalTimestamp(date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ` +
    `${offsetSign}${pad(Math.floor(absoluteOffset / 60))}:${pad(absoluteOffset % 60)}`
  );
}

function prefixLogLines(message: string) {
  const prefix = `[${formatLocalTimestamp()}] `;
  return message
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function installTimestampedConsoleForDaemonRun() {
  console.log = (...args: unknown[]) => {
    process.stdout.write(`${prefixLogLines(format(...args))}\n`);
  };
  console.warn = (...args: unknown[]) => {
    process.stderr.write(`${prefixLogLines(format(...args))}\n`);
  };
  console.error = (...args: unknown[]) => {
    process.stderr.write(`${prefixLogLines(format(...args))}\n`);
  };
}

function printHelp() {
  console.log(`kiki-daemon — Kiki 本地执行节点

用法:
  kiki-daemon run        --server-url <url> --api-key <key>   前台运行（关终端即停止）
  kiki-daemon install    --server-url <url> --api-key <key>   注册后台服务 + 开机自启
  kiki-daemon uninstall                                        卸载后台服务
  kiki-daemon status                                           查看后台服务状态
  kiki-daemon version                                          查看当前版本
  kiki-daemon help                                             显示本帮助

示例:
  npm i -g @kiki_agent/daemon@latest && kiki-daemon install --server-url https://kiki.example.com --api-key sk_machine_xxx
`);
}

async function main() {
  const subcommand = resolveSubcommand();

  if (subcommand === "help") {
    printHelp();
    return;
  }

  if (subcommand === "version") {
    console.log(`kiki-daemon ${DAEMON_PACKAGE_VERSION}`);
    return;
  }

  if (subcommand === "status") {
    const status = await serviceStatus();
    if (status.kind === "unsupported") {
      console.log(`当前平台 ${process.platform} 不支持后台服务管理。`);
      console.log(`版本: ${DAEMON_PACKAGE_VERSION}`);
      return;
    }
    console.log(`后台服务（${status.kind}）:`);
    console.log(`  CLI 版本: ${DAEMON_PACKAGE_VERSION}`);
    console.log(`  已安装: ${status.installed ? "是" : "否"}`);
    console.log(`  运行中: ${status.running ? "是" : "否"}`);
    if (status.pid) console.log(`  进程号: ${status.pid}`);
    if (status.running) console.log(`  进程版本: ${status.daemonVersion ?? "未知"}`);
    if (status.path) console.log(`  配置文件: ${status.path}`);
    return;
  }

  if (subcommand === "uninstall") {
    const result = await uninstallDaemonService();
    console.log(`已卸载后台服务（${result.kind}）：${result.path}`);
    return;
  }

  if (subcommand === "install") {
    const { serverUrl, apiKey } = requireConnectionArgs();
    const scriptPath = resolveInstallScriptPath();
    if (scriptPath.includes(`${path.sep}_npx${path.sep}`)) {
      console.warn(
        "⚠️  检测到通过 npx 临时缓存运行，该路径可能被清理导致后台服务失效。\n" +
          "    建议先全局安装再 install：npm i -g @kiki_agent/daemon && kiki-daemon install ...",
      );
    }
    const result = await installDaemonService({
      nodePath: process.execPath,
      scriptPath,
      serverUrl,
      apiKey,
      environment: collectDaemonServiceEnv(process.env),
    });
    const pathDirs = (collectDaemonServiceEnv(process.env).PATH || "").split(path.delimiter).length;
    console.log(`已安装并启动后台服务（${result.kind}）：${result.path}`);
    console.log(`后台 PATH 已写入 ${pathDirs} 个目录（含 ~/.local/bin、Homebrew 等常见路径）。`);
    console.log("现在可以关闭终端，daemon 将在后台常驻并随开机自启。");
    console.log("查看状态：kiki-daemon status");
    return;
  }

  installTimestampedConsoleForDaemonRun();

  const { serverUrl, apiKey } = requireConnectionArgs();
  const scriptPath = resolveInstallScriptPath();
  const environment = collectDaemonServiceEnv(process.env);
  console.log(`[kiki-daemon] 前台运行，连接 ${serverUrl}`);
  if (scriptPath.includes(`${path.sep}_npx${path.sep}`)) {
    console.warn(
      "⚠️  当前通过 npx 临时缓存运行。若从网页开启 24h 运行，建议先全局安装：npm i -g @kiki_agent/daemon",
    );
  }
  // 进程级单例：启动时主动终止其它存活的 daemon run 实例（含覆盖安装后残留的旧版进程、
  // 游离前台进程），避免新旧进程用同一 apiKey 抢同一 machineId 的 WS 连接互相顶替。
  ensureSingleDaemonInstance({
    version: DAEMON_PACKAGE_VERSION,
    log: (message) => console.log(`[kiki-daemon] ${message}`),
  });
  writeDaemonProcessState({ daemonVersion: DAEMON_PACKAGE_VERSION });
  // 守护进程兜底：偶发的未捕获异常不应让进程退出，交由重连循环恢复。
  process.on("unhandledRejection", (reason) => {
    console.error("[kiki-daemon] unhandledRejection:", reason instanceof Error ? reason.message : reason);
  });
  process.on("uncaughtException", (error) => {
    console.error("[kiki-daemon] uncaughtException:", error instanceof Error ? error.message : error);
  });
  await runRemoteDaemonLoop({
    serverUrl,
    apiKey,
    daemonVersion: DAEMON_PACKAGE_VERSION,
    serviceManager: {
      async installService() {
        const installScriptPath = resolveInstallScriptPath();
        await installDaemonService({
          nodePath: process.execPath,
          scriptPath: installScriptPath,
          serverUrl,
          apiKey,
          environment,
        });
        return remoteServiceStatus();
      },
      async uninstallService() {
        await uninstallDaemonService();
        return remoteServiceStatus();
      },
      serviceStatus: remoteServiceStatus,
    },
  });
}

void main().catch((error) => {
  console.error("[kiki-daemon] 启动失败:", error instanceof Error ? error.message : error);
  process.exit(1);
});

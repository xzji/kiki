import path from "path";

import { runRemoteDaemonLoop } from "@/lib/daemon/remoteDaemonLoop";
import type { RemoteDaemonServiceStatus } from "@/lib/server/tunnel/tunnelHub";

import { collectDaemonServiceEnv } from "./pathEnv";
import {
  installService as installDaemonService,
  resolveInstallScriptPath,
  serviceStatus,
  uninstallService as uninstallDaemonService,
} from "./service";

type Subcommand = "run" | "install" | "uninstall" | "status" | "help";

function readArg(flag: string): string | undefined {
  const direct = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  if (direct) return direct.slice(flag.length + 1);
  const index = process.argv.indexOf(flag);
  if (index >= 0) return process.argv[index + 1];
  return undefined;
}

function resolveSubcommand(): Subcommand {
  const positional = process.argv.slice(2).find((arg) => !arg.startsWith("-"));
  if (positional === "install" || positional === "uninstall" || positional === "status" || positional === "help") {
    return positional;
  }
  if (process.argv.includes("--help") || process.argv.includes("-h")) return "help";
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

function printHelp() {
  console.log(`kiki-daemon — Kiki 本地执行节点

用法:
  kiki-daemon run        --server-url <url> --api-key <key>   前台运行（关终端即停止）
  kiki-daemon install    --server-url <url> --api-key <key>   注册后台服务 + 开机自启
  kiki-daemon uninstall                                        卸载后台服务
  kiki-daemon status                                           查看后台服务状态
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

  if (subcommand === "status") {
    const status = await serviceStatus();
    if (status.kind === "unsupported") {
      console.log(`当前平台 ${process.platform} 不支持后台服务管理。`);
      return;
    }
    console.log(`后台服务（${status.kind}）:`);
    console.log(`  已安装: ${status.installed ? "是" : "否"}`);
    console.log(`  运行中: ${status.running ? "是" : "否"}`);
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

  const { serverUrl, apiKey } = requireConnectionArgs();
  const scriptPath = resolveInstallScriptPath();
  const environment = collectDaemonServiceEnv(process.env);
  console.log(`[kiki-daemon] 前台运行，连接 ${serverUrl}`);
  if (scriptPath.includes(`${path.sep}_npx${path.sep}`)) {
    console.warn(
      "⚠️  当前通过 npx 临时缓存运行。若从网页开启 24h 运行，建议先全局安装：npm i -g @kiki_agent/daemon",
    );
  }
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

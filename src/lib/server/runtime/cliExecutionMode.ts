import { isServerLocalCliDisabled } from "@/lib/server/runtime/cloudExecutionPolicy";

/** 远程 daemon 在本机执行 CLI 时设置，避免再次代理回云端造成循环。 */
export function isMachineExecutor() {
  return process.env.KIKI_MACHINE_EXECUTOR?.trim() === "true";
}

/** 云端控制面应把 Claude CLI 代理到在线 machine 执行。 */
export function shouldProxyCliToMachine() {
  return isServerLocalCliDisabled() && !isMachineExecutor();
}

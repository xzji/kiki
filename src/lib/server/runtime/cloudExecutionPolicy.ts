const LOCAL_CLI_ONLY =
  process.env.KIKI_LOCAL_CLI_ONLY?.trim() === "true" ||
  process.env.KIKI_ORCHESTRATOR_MODE?.trim() === "cloud";

export function isServerLocalCliDisabled() {
  return LOCAL_CLI_ONLY;
}

export function assertServerLocalCliAllowed() {
  if (!isServerLocalCliDisabled()) return;
  throw new Error(
    "云端控制面不运行 Claude CLI。请先连接本机 machine（pnpm daemon:remote），规划与执行均在本地完成。",
  );
}

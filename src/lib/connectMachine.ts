export type ConnectCommandMode = "install" | "run";

export function buildConnectCommand(input: {
  serverUrl: string;
  apiKey: string;
  mode?: ConnectCommandMode;
}) {
  const serverUrl = input.serverUrl.replace(/\/$/, "");
  const subcommand = input.mode === "run" ? "run" : "install";
  return `npx @kiki/daemon@latest ${subcommand} --server-url ${serverUrl} --api-key ${input.apiKey}`;
}

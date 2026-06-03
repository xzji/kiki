export type SlashCommandName = "goal" | "saga";

export type SlashCommand = {
  name: SlashCommandName;
  label: string;
  description: string;
  usage: string;
  placeholder: string;
};

export type SlashCommandParseResult =
  | { kind: "plain"; content: string }
  | { kind: "command"; command: SlashCommandName; payload: string }
  | { kind: "unknown"; commandText: string; payload: string };

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "goal",
    label: "长程目标任务",
    description: "把后续内容转为长期目标，并生成可执行任务计划",
    usage: "/goal 准备托福 110 分",
    placeholder: "描述一个长期目标，例如 /goal 三个月内托福达到 110 分",
  },
  {
    name: "saga",
    label: "5 角色拆解",
    description: "使用新 5 角色 Saga 直接生成规划草案",
    usage: "/saga 帮我持续跟踪美股科技板块",
    placeholder: "描述一个想持续推进或监控的话题，例如 /saga 帮我持续跟踪美股科技板块",
  },
];

export function parseSlashCommand(input: string): SlashCommandParseResult {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return { kind: "plain", content: trimmed };

  const [rawCommand = "", ...rest] = trimmed.split(/\s+/);
  const commandText = rawCommand.slice(1).toLowerCase();
  const payload = rest.join(" ").trim();
  const command = SLASH_COMMANDS.find((item) => item.name === commandText);

  if (!command) {
    return { kind: "unknown", commandText: rawCommand, payload };
  }

  return { kind: "command", command: command.name, payload };
}

export function getSlashCommandSuggestions(input: string) {
  if (!input.startsWith("/")) return [];
  const firstToken = input.split(/\s+/)[0] ?? "";
  if (input.includes(" ") || firstToken.length === 0) return [];
  const query = firstToken.slice(1).toLowerCase();
  return SLASH_COMMANDS.filter((command) => command.name.startsWith(query));
}

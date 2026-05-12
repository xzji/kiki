function asRecord(input: unknown) {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : null;
}

function readStringField(input: unknown, keys: string[]) {
  const record = asRecord(input);
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function truncate(value: string, max = 160) {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}

export function summarizeToolOperation(toolName: string | undefined, input: unknown) {
  if (!input || typeof input !== "object") return undefined;
  if (Array.isArray(input)) {
    if (input.length === 0) return undefined;
  } else if (Object.keys(input as Record<string, unknown>).length === 0) {
    return undefined;
  }

  const normalized = toolName?.toLowerCase() || "";
  const query = readStringField(input, ["query", "information_request", "pattern", "description"]);
  const url = readStringField(input, ["url", "href"]);
  const filePath = readStringField(input, ["file_path", "path", "target_file", "file"]);
  const cwd = readStringField(input, ["cwd", "workingDirectory"]);
  const command = readStringField(input, ["command"]);

  if (normalized.includes("websearch")) {
    return query ? `关键词：${truncate(query)}` : undefined;
  }
  if (normalized.includes("webfetch")) {
    return url ? `URL：${truncate(url)}` : undefined;
  }
  if (normalized.includes("read") || normalized.includes("write") || normalized.includes("edit") || normalized.includes("patch")) {
    return filePath ? `文件：${truncate(filePath)}` : undefined;
  }
  if (normalized.includes("grep")) {
    return query ? `模式：${truncate(query)}` : undefined;
  }
  if (normalized.includes("glob") || normalized.includes("searchcodebase") || normalized === "ls") {
    return query ? `对象：${truncate(query)}` : filePath ? `路径：${truncate(filePath)}` : undefined;
  }
  if (normalized.includes("runcommand") || normalized.includes("bash")) {
    if (command && cwd) return `命令：${truncate(command)}\n目录：${truncate(cwd)}`;
    if (command) return `命令：${truncate(command)}`;
    return cwd ? `目录：${truncate(cwd)}` : undefined;
  }

  try {
    const text = JSON.stringify(input, null, 2);
    return text.length > 600 ? `${text.slice(0, 600)}...` : text;
  } catch {
    return undefined;
  }
}

function stripSummaryPrefix(summary: string) {
  return summary.replace(/^(关键词|URL|文件|模式|对象|路径|命令|目录)：\s*/, "").trim();
}

export function formatToolOperationText(title: string, summary?: string) {
  if (!summary?.trim()) return title;
  const normalizedTitle = title
    .replace(/搜索网页信息/g, "搜索网页")
    .replace(/抓取网页内容/g, "抓取网页")
    .replace(/读取文件内容/g, "读取文件")
    .replace(/编辑代码文件/g, "编辑文件");
  return `${normalizedTitle}：${stripSummaryPrefix(summary)}`;
}

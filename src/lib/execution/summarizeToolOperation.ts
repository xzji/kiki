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

function readStringArrayField(input: unknown, keys: string[]) {
  const record = asRecord(input);
  if (!record) return [];
  for (const key of keys) {
    const value = record[key];
    if (!Array.isArray(value)) continue;
    return value.flatMap((item) => {
      if (typeof item === "string" && item.trim()) return [item.trim()];
      const nested = readStringField(item, ["file_path", "path", "target_file", "file", "filename", "name"]);
      return nested ? [nested] : [];
    });
  }
  return [];
}

function truncate(value: string, max = 160) {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}

function unique(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function basename(path: string) {
  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).at(-1) ?? path;
}

export type ToolOperationDisplay = {
  action: string;
  objectText?: string;
  paths?: string[];
};

export function extractToolFilePaths(input: unknown) {
  const directPath = readStringField(input, ["file_path", "path", "target_file", "file"]);
  return unique([
    ...(directPath ? [directPath] : []),
    ...readStringArrayField(input, ["file_paths", "paths", "target_files", "files"]),
  ]);
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
    const filePaths = extractToolFilePaths(input);
    if (filePaths.length > 1) return `文件：${filePaths.map((path) => truncate(path)).join("\n")}`;
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

function parseSummaryPaths(summary: string | undefined) {
  if (!summary?.trim()) return [];
  const stripped = stripSummaryPrefix(summary);
  return unique(
    stripped
      .split(/\n+/)
      .map((line) => line.trim().replace(/^文件\s*\d*[:：]\s*/, ""))
      .filter((line) => line.includes("/") || line.includes("\\")),
  );
}

function pathListText(paths: string[], maxVisible = 4) {
  const visible = paths.slice(0, maxVisible).map(basename);
  return `${visible.join(", ")}${paths.length > maxVisible ? " 等" : ""}`;
}

export function formatToolOperationDisplay(
  toolName: string,
  title: string,
  summary?: string,
  input?: unknown,
): ToolOperationDisplay {
  const normalizedToolName = toolName.toLowerCase();
  const isFileMutation =
    normalizedToolName.includes("write") ||
    normalizedToolName.includes("edit") ||
    normalizedToolName.includes("patch");
  const isFileRead = normalizedToolName.includes("read");
  const inputPaths = extractToolFilePaths(input);
  const summaryPaths = parseSummaryPaths(summary);
  const paths = unique([...inputPaths, ...summaryPaths]);

  if ((isFileMutation || isFileRead) && paths.length) {
    const actionPrefix = isFileMutation ? "编辑" : "读取";
    return {
      action: paths.length > 1 ? `${actionPrefix} ${paths.length} 个文件` : `${actionPrefix}文件`,
      objectText: pathListText(paths),
      paths,
    };
  }

  return {
    action: formatToolOperationText(title, summary),
  };
}

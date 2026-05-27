export function extractBalancedJsonSnippet(text: string) {
  const startIndex = text.search(/[\{\[]/);
  if (startIndex < 0) return text.trim();

  const opener = text[startIndex];
  const closer = opener === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === opener) {
      depth += 1;
      continue;
    }
    if (char === closer) {
      depth -= 1;
      if (depth === 0) {
        return text.slice(startIndex, index + 1).trim();
      }
    }
  }

  return text.slice(startIndex).trim();
}

export function extractJsonObject(raw: string) {
  const snippet = extractBalancedJsonSnippet(raw);
  if (!snippet || !snippet.startsWith("{")) {
    throw new Error("任务执行结果不是合法 JSON");
  }
  return snippet;
}

export function tryExtractJsonObject(raw: string) {
  const snippet = extractBalancedJsonSnippet(raw);
  return snippet && snippet.startsWith("{") ? snippet : null;
}

function extractErrorPosition(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const matched = message.match(/position\s+(\d+)/i);
  if (!matched) return undefined;
  const position = Number(matched[1]);
  return Number.isFinite(position) ? position : undefined;
}

export function extractParseFailureContext(raw: string, error: unknown, radius = 200) {
  const message = error instanceof Error ? error.message : String(error ?? "JSON 解析失败");
  const position = extractErrorPosition(error);
  if (position === undefined) {
    return {
      message,
      position,
      excerpt: raw.slice(0, Math.min(raw.length, radius * 2)),
      formatted: message,
    };
  }

  const start = Math.max(0, position - radius);
  const end = Math.min(raw.length, position + radius);
  const excerpt = raw.slice(start, end);
  const pointerOffset = Math.max(0, position - start);
  const pointer = `${" ".repeat(pointerOffset)}^`;
  return {
    message,
    position,
    excerpt,
    formatted: [
      message,
      `位置: ${position}`,
      "上下文:",
      excerpt,
      pointer,
    ].join("\n"),
  };
}

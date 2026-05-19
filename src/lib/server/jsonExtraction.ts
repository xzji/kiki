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

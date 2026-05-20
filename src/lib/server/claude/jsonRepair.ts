import { extractBalancedJsonSnippet } from "@/lib/server/jsonExtraction";

type ClaudeJsonPayload = {
  result?: string;
  message?: {
    content?: Array<{
      text?: string;
    }>;
  };
};

export type JsonParseCandidate = {
  label: string;
  value: string;
};

export type JsonParseAttempt<T> =
  | {
      ok: true;
      parsed: T;
      strategy: string;
    }
  | {
      ok: false;
      error: unknown;
    };

export function stripJsonFences(text: string) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

export function extractTextFromClaudeJsonPayload(raw: string) {
  const text = raw.trim();
  if (!text) return "";

  try {
    const parsed = JSON.parse(text) as ClaudeJsonPayload;
    if (typeof parsed.result === "string") return parsed.result;
    const content = parsed.message?.content?.map((item) => item.text || "").join("");
    if (content) return content;
  } catch {
    // Fall through to raw text parsing.
  }

  return text;
}

export function normalizeClaudeJsonText(raw: string) {
  return stripJsonFences(extractTextFromClaudeJsonPayload(raw));
}

export function repairCommonJsonIssues(text: string) {
  return text
    .replace(/^\uFEFF/, "")
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/(["\]\}\d])\s*\n\s*("[-_$a-zA-Z0-9\u4e00-\u9fa5]+":)/g, "$1,\n$2")
    .replace(/(["\]\}\d])\s+("[-_$a-zA-Z0-9\u4e00-\u9fa5]+":)/g, "$1, $2")
    .trim();
}

export function buildJsonParseCandidates(primary: string): JsonParseCandidate[] {
  const balanced = extractBalancedJsonSnippet(primary);
  return [
    { label: "primary", value: primary },
    { label: "balanced", value: balanced },
    { label: "common_repair", value: repairCommonJsonIssues(primary) },
    { label: "balanced_common_repair", value: repairCommonJsonIssues(balanced) },
  ];
}

export function parseJsonWithCandidates<T>(
  candidates: JsonParseCandidate[],
  validator: (value: unknown) => T,
): JsonParseAttempt<T> {
  let lastError: unknown = null;
  for (const candidate of candidates) {
    if (!candidate.value) continue;
    try {
      return {
        ok: true,
        parsed: validator(JSON.parse(candidate.value) as unknown),
        strategy: candidate.label,
      };
    } catch (error) {
      lastError = error;
    }
  }
  return {
    ok: false,
    error: lastError,
  };
}

export function parseRepairedJsonText<T>(
  repairedText: string,
  validator: (value: unknown) => T,
): JsonParseAttempt<T> & { candidateForLog: string } {
  const balancedCommonRepair = repairCommonJsonIssues(extractBalancedJsonSnippet(repairedText));
  const attempt = parseJsonWithCandidates(
    [
      { label: "repaired_balanced_common_repair", value: balancedCommonRepair },
      ...buildJsonParseCandidates(repairedText),
    ],
    validator,
  );
  return {
    ...attempt,
    candidateForLog: balancedCommonRepair,
  };
}

export function buildJsonRepairPrompt(malformedJson: string) {
  return `你是 JSON 修复助手。请把下面这段不合法或不完整的 JSON 修复为严格合法的 JSON。

要求：
1. 只能输出修复后的严格 JSON。
2. 不要输出 Markdown、解释、代码块或额外说明。
3. 尽量保留原始字段和值语义，不要擅自改写业务含义。

待修复内容：
${malformedJson}`;
}

import type { ArtifactKind, ArtifactRef } from "@/types/artifact";
import type { ResultBlock, ResultCell, TaskResult, TaskResultExportFormat, TaskResultPrimaryFormat, TaskResultPresentation, TaskResultStatus } from "@/types/taskResult";

type NormalizeInput = {
  taskId: string;
  instanceId: string;
  title: string;
};

const ALLOWED_STATUSES: TaskResultStatus[] = ["draft", "pending_user", "done", "blocked", "failed"];
const ALLOWED_PRESENTATIONS: TaskResultPresentation[] = ["summary_card", "visual_report", "comparison_table", "checklist", "timeline", "document", "dashboard", "handoff_package"];
const ALLOWED_PRIMARY_FORMATS: TaskResultPrimaryFormat[] = ["structured_blocks", "json", "markdown", "html", "text", "code"];
const ALLOWED_EXPORT_FORMATS: TaskResultExportFormat[] = ["html", "markdown", "json", "text"];
const ALLOWED_ARTIFACT_KINDS: ArtifactKind[] = ["text_block", "file", "external_link", "webapp", "external_embed"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function asString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function asStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.map((item) => asString(item)).filter(Boolean)
    : [];
}

function normalizeEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && allowed.includes(value as T) ? (value as T) : undefined;
}

function normalizeEnumArray<T extends string>(value: unknown, allowed: readonly T[]): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is T => typeof item === "string" && allowed.includes(item as T));
  return items.length ? Array.from(new Set(items)) : undefined;
}

function normalizeCell(value: unknown): ResultCell {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (isRecord(value)) {
    const text = asString(value.text);
    if (!text) return "";
    const tone =
      value.tone === "good" || value.tone === "bad" || value.tone === "warn" || value.tone === "default"
        ? value.tone
        : undefined;
    return tone ? { text, tone } : { text };
  }
  return "";
}

function normalizeHeadingBlock(block: Record<string, unknown>): ResultBlock | null {
  const text = asString(block.text);
  if (!text) return null;
  const level = block.level === 1 || block.level === 2 || block.level === 3 ? block.level : 2;
  return { kind: "heading", text, level };
}

function normalizeParagraphBlock(block: Record<string, unknown>): ResultBlock | null {
  const text = asString(block.text);
  return text ? { kind: "paragraph", text } : null;
}

function normalizeMarkdownBlock(block: Record<string, unknown>): ResultBlock | null {
  const content = asString(block.content);
  return content ? { kind: "markdown", content } : null;
}

function normalizeListBlock(block: Record<string, unknown>): ResultBlock | null {
  const items = asStringArray(block.items);
  return items.length ? { kind: "list", ordered: block.ordered === true, items } : null;
}

function normalizeKeyValueBlock(block: Record<string, unknown>): ResultBlock | null {
  const entries = Array.isArray(block.entries)
    ? block.entries
        .filter(isRecord)
        .map((entry) => ({
          label: asString(entry.label),
          value: normalizeCell(entry.value),
          emphasis: entry.emphasis === true,
        }))
        .filter((entry) => entry.label)
    : [];
  return entries.length ? { kind: "key_value", entries } : null;
}

function normalizeComparisonTableBlock(block: Record<string, unknown>): ResultBlock | null {
  const columns = asStringArray(block.columns);
  const rows = Array.isArray(block.rows)
    ? block.rows.filter(isRecord).map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [key, normalizeCell(value)]),
        ),
      )
    : [];
  const highlight = Array.isArray(block.highlight)
    ? block.highlight.filter((item): item is number => typeof item === "number")
    : undefined;
  return columns.length && rows.length ? { kind: "comparison_table", columns, rows, highlight } : null;
}

function normalizeDecisionBlock(block: Record<string, unknown>): ResultBlock | null {
  const question = asString(block.question);
  const options = Array.isArray(block.options)
    ? block.options
        .filter(isRecord)
        .map((option, index) => ({
          id: asString(option.id) || `option-${index + 1}`,
          label: asString(option.label),
          rationale: asString(option.rationale) || undefined,
          recommended: option.recommended === true,
        }))
        .filter((option) => option.label)
    : [];
  return question && options.length
    ? { kind: "decision", question, options, selectedOptionId: asString(block.selectedOptionId) || undefined }
    : null;
}

function normalizeCalloutBlock(block: Record<string, unknown>): ResultBlock | null {
  const text = asString(block.text);
  if (!text) return null;
  const tone = block.tone === "warn" || block.tone === "success" || block.tone === "risk" ? block.tone : "info";
  return { kind: "callout", tone, text };
}

function normalizeBlock(value: unknown): ResultBlock | null {
  if (!isRecord(value)) return null;
  switch (value.kind) {
    case "heading":
      return normalizeHeadingBlock(value);
    case "paragraph":
      return normalizeParagraphBlock(value);
    case "markdown":
      return normalizeMarkdownBlock(value);
    case "list":
      return normalizeListBlock(value);
    case "key_value":
      return normalizeKeyValueBlock(value);
    case "comparison_table":
      return normalizeComparisonTableBlock(value);
    case "decision":
      return normalizeDecisionBlock(value);
    case "callout":
      return normalizeCalloutBlock(value);
    default:
      return null;
  }
}

function normalizeArtifactRefs(value: unknown): ArtifactRef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const refs = value
    .filter(isRecord)
    .map((item): ArtifactRef | null => {
      const id = asString(item.id);
      const label = asString(item.label);
      const kind = normalizeEnum(item.kind, ALLOWED_ARTIFACT_KINDS);
      if (!id || !label || !kind) return null;
      const ref: ArtifactRef = {
        id,
        kind,
        label,
        summary: asString(item.summary) || undefined,
        mime: asString(item.mime) || undefined,
        size: typeof item.size === "number" ? item.size : undefined,
        previewUrl: asString(item.previewUrl) || undefined,
        provider: item.provider === "youtube" ? "youtube" : item.provider === "generic" ? "generic" : undefined,
        embedUrl: asString(item.embedUrl) || undefined,
        url: asString(item.url) || undefined,
        allowFullScreen: typeof item.allowFullScreen === "boolean" ? item.allowFullScreen : undefined,
        surfaceKind: item.surfaceKind === "webapp" || item.surfaceKind === "external_embed" ? item.surfaceKind : undefined,
      };
      return ref;
    })
    .filter((item): item is ArtifactRef => Boolean(item));
  return refs.length ? refs : undefined;
}

export function normalizeTaskResult(value: unknown, fallback: NormalizeInput): TaskResult | null {
  if (!isRecord(value)) return null;
  const blocks: ResultBlock[] = Array.isArray(value.blocks)
    ? value.blocks
        .map(normalizeBlock)
        .filter((block): block is ResultBlock => Boolean(block))
    : [];
  const artifactRefs = normalizeArtifactRefs(value.artifactRefs);
  if (!blocks.length && !artifactRefs?.length) return null;
  const status = ALLOWED_STATUSES.includes(value.status as TaskResultStatus)
    ? (value.status as TaskResultStatus)
    : "done";
  const meta = isRecord(value.meta) ? value.meta : {};
  return {
    schemaVersion: 1,
    taskId: asString(value.taskId) || fallback.taskId,
    instanceId: asString(value.instanceId) || fallback.instanceId,
    title: asString(value.title) || fallback.title,
    status,
    blocks,
    artifactRefs,
    meta: {
      producedAt: asString(meta.producedAt) || new Date().toISOString(),
      surfaces: normalizeEnumArray(meta.surfaces, ["interactive", "files"]),
      interactiveSurfaceKind: normalizeEnum(meta.interactiveSurfaceKind, ["blocks", "iframe", "webapp", "dashboard", "form", "table"]),
      fileSurfaceRequired: typeof meta.fileSurfaceRequired === "boolean" ? meta.fileSurfaceRequired : undefined,
      presentation: normalizeEnum(meta.presentation, ALLOWED_PRESENTATIONS),
      primaryFormat: normalizeEnum(meta.primaryFormat, ALLOWED_PRIMARY_FORMATS),
      exportableFormats: normalizeEnumArray(meta.exportableFormats, ALLOWED_EXPORT_FORMATS),
      durationMs: typeof meta.durationMs === "number" ? meta.durationMs : undefined,
      tokensUsed: typeof meta.tokensUsed === "number" ? meta.tokensUsed : undefined,
    },
  };
}

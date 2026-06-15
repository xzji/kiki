import { type TaskDraft, type TaskDraftBatch, type TaskDraftDropReason } from "./taskDraftSchema";
import { normalizeRequiredUserInputs } from "@/lib/server/informationRequest/compileFields";

const TASK_OPEN_RE = /^\s*<task(?:\s+index=["']?(\d+)["']?)?\s*>\s*$/i;
const TASK_CLOSE_RE = /^\s*<\/task>\s*$/i;
const FIELD_OPEN_RE = /^\s*<([a-z][a-z-]*)([^>]*)>(.*)$/i;
const FIELD_CLOSE_RE = /^\s*<\/([a-z][a-z-]*)>\s*$/i;
const SELF_CLOSING_RE = /^\s*<([a-z][a-z-]*)([^>]*)\/>\s*$/i;

export type ParsedTaskDraftBatch = TaskDraftBatch & {
  rawOutput: string;
};

type FieldState = {
  name: string;
  value: string[];
  inCdata: boolean;
};

type ParsedTask = {
  index: number;
  raw: string;
  fields: Record<string, string[]>;
  attributes: Record<string, Record<string, string>>;
  warnings: string[];
};

function stripFencedWrappers(raw: string) {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:xml|text|markdown)?\s*\n([\s\S]*?)\n```$/i);
  return match ? match[1] : raw;
}

function decodeCdata(value: string) {
  const trimmed = value.trim();
  const match = trimmed.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return match ? match[1] : value;
}

function updateCdataState(current: FieldState, line: string) {
  if (!current.inCdata && line.includes("<![CDATA[") && !line.includes("]]>")) {
    current.inCdata = true;
    return;
  }
  if (current.inCdata && line.includes("]]>")) {
    current.inCdata = false;
  }
}

function attrs(raw: string) {
  const result: Record<string, string> = {};
  const attrRe = /([a-z][a-z-]*)=(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let match = attrRe.exec(raw);
  while (match) {
    result[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
    match = attrRe.exec(raw);
  }
  return result;
}

function listFromText(value: string) {
  return value
    .split(/\n|；|;/)
    .map((item) => item.replace(/^\s*[-*]\s*/, "").trim())
    .filter(Boolean);
}

function first(fields: Record<string, string[]>, name: string) {
  return decodeCdata((fields[name]?.[0] ?? "").trim());
}

/**
 * 解析 <required-inputs> 字段文本，每行形如：
 * `- id: departure_city | label: 出发城市 | question: 你从哪出发？ | options: 北京,上海 | satisfied: 出现明确城市`
 * 返回原始对象数组，交由 normalizeRequiredUserInputs 做最终归一化。
 */
function parseRequiredInputsText(value: string): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.replace(/^\s*[-*]\s*/, "").trim();
    if (!line) continue;
    const record: Record<string, unknown> = {};
    for (const segment of line.split("|")) {
      const sepIndex = segment.search(/[:：]/);
      if (sepIndex < 0) continue;
      const key = segment.slice(0, sepIndex).trim().toLowerCase();
      const val = segment.slice(sepIndex + 1).trim();
      if (!key || !val) continue;
      if (key === "options") {
        record.options = val.split(/[,，、]/).map((item) => item.trim()).filter(Boolean);
      } else {
        record[key] = val;
      }
    }
    if (Object.keys(record).length > 0) result.push(record);
  }
  return result;
}

function parseTaskBlock(raw: string, fallbackIndex: number): ParsedTask {
  const lines = raw.split(/\r?\n/);
  const open = lines[0]?.match(TASK_OPEN_RE);
  const index = open?.[1] ? Number(open[1]) : fallbackIndex;
  const fields: Record<string, string[]> = {};
  const attributes: Record<string, Record<string, string>> = {};
  const warnings: string[] = [];
  let current: FieldState | null = null;

  const flush = (implicit = false) => {
    if (!current) return;
    const value = current.value.join("\n").trim();
    fields[current.name] = [...(fields[current.name] ?? []), value];
    if (implicit) warnings.push(`field ${current.name} implicitly closed`);
    current = null;
  };

  for (const line of lines.slice(1)) {
    if (current?.inCdata) {
      const cdataEnd = line.indexOf("]]>");
      if (cdataEnd >= 0) {
        current.value.push(line.slice(0, cdataEnd + 3));
        current.inCdata = false;
        const rest = line.slice(cdataEnd + 3).trim();
        const close = rest.match(FIELD_CLOSE_RE);
        if (close && close[1].toLowerCase() === current.name) {
          flush();
        } else if (rest) {
          current.value.push(rest);
        }
      } else {
        current.value.push(line);
      }
      continue;
    }
    if (TASK_CLOSE_RE.test(line)) {
      flush();
      continue;
    }
    const selfClosing = line.match(SELF_CLOSING_RE);
    if (selfClosing) {
      flush(true);
      attributes[selfClosing[1].toLowerCase()] = attrs(selfClosing[2] ?? "");
      continue;
    }
    const close = line.match(FIELD_CLOSE_RE);
    if (close && current && close[1].toLowerCase() === current.name) {
      flush();
      continue;
    }
    const openField = line.match(FIELD_OPEN_RE);
    if (openField && !TASK_OPEN_RE.test(line)) {
      flush(true);
      const name = openField[1].toLowerCase();
      const attrText = openField[2] ?? "";
      const rest = openField[3] ?? "";
      attributes[name] = attrs(attrText);
      const sameLineClose = rest.match(new RegExp(`([\\s\\S]*?)<\\/${name}>\\s*$`, "i"));
      if (sameLineClose) {
        fields[name] = [...(fields[name] ?? []), sameLineClose[1].trim()];
      } else {
        current = { name, value: rest.trim() ? [rest] : [], inCdata: rest.includes("<![CDATA[") && !rest.includes("]]>") };
      }
      continue;
    }
    if (current) {
      current.value.push(line);
      updateCdataState(current, line);
    }
  }
  flush(true);
  return { index, raw, fields, attributes, warnings };
}

function toDraft(parsed: ParsedTask): { draft?: TaskDraft; reason?: TaskDraftDropReason } {
  const involvementAttrs = parsed.attributes["user-involvement"] ?? {};
  const dependencyText = first(parsed.fields, "dependencies");
  const priority = first(parsed.fields, "priority");
  const minutesText = first(parsed.fields, "duration-minutes");
  const draft: TaskDraft = {
    index: parsed.index,
    title: first(parsed.fields, "title"),
    objective: first(parsed.fields, "objective"),
    deliverable: first(parsed.fields, "deliverable"),
    acceptanceCriteria: listFromText(first(parsed.fields, "acceptance")),
    cadence: first(parsed.fields, "cadence") || undefined,
    triggerCondition: first(parsed.fields, "trigger-condition") || undefined,
    dependencyHints: listFromText(dependencyText.replace(/,/g, "\n")),
    priorityHint: priority === "critical" || priority === "high" || priority === "medium" || priority === "low" ? priority : undefined,
    estimatedMinutes: /^\d+$/.test(minutesText) ? Number(minutesText) : undefined,
    notes: first(parsed.fields, "notes") || undefined,
    requiredUserInputs: normalizeRequiredUserInputs(parseRequiredInputsText(first(parsed.fields, "required-inputs"))),
    userInvolvement: {
      mode:
        involvementAttrs.mode === "none" || involvementAttrs.mode === "confirm" || involvementAttrs.mode === "answer" || involvementAttrs.mode === "collaborate"
          ? involvementAttrs.mode
          : undefined,
      reason: involvementAttrs.reason,
      actionLabel: involvementAttrs["action-label"],
    },
  };
  const missingFields: string[] = [];
  if (!draft.title) missingFields.push("title");
  if (!draft.objective) missingFields.push("objective");
  if (!draft.deliverable) missingFields.push("deliverable");
  if (draft.acceptanceCriteria.length === 0) missingFields.push("acceptanceCriteria");
  if (missingFields.length > 0) {
    return { reason: { index: parsed.index, missingFields, reason: "Block 缺少必填字段", rawBlock: parsed.raw } };
  }
  return { draft };
}

export function parseTaskDraftBatch(raw: string): ParsedTaskDraftBatch {
  const normalized = stripFencedWrappers(raw);
  const lines = normalized.split(/\r?\n/);
  const blocks: string[] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (TASK_OPEN_RE.test(line)) {
      if (current) blocks.push(current.join("\n"));
      current = [line];
      continue;
    }
    if (current) {
      current.push(line);
      if (TASK_CLOSE_RE.test(line)) {
        blocks.push(current.join("\n"));
        current = null;
      }
    }
  }
  if (current) blocks.push(current.join("\n"));

  const tasks: TaskDraft[] = [];
  const droppedReasons: TaskDraftDropReason[] = [];
  const warnings: string[] = [];
  const rawBlocks: Array<{ index: number; raw: string }> = [];
  if (blocks.length === 0) {
    droppedReasons.push({
      index: 1,
      missingFields: ["task"],
      reason: "输出中未找到 task block",
      rawBlock: raw,
    });
  }
  blocks.forEach((block, index) => {
    try {
      const parsed = parseTaskBlock(block, index + 1);
      rawBlocks.push({ index: parsed.index, raw: block });
      warnings.push(...parsed.warnings.map((warning) => `task ${parsed.index}: ${warning}`));
      const converted = toDraft(parsed);
      if (converted.draft) tasks.push(converted.draft);
      if (converted.reason) droppedReasons.push(converted.reason);
    } catch (error) {
      droppedReasons.push({
        index: index + 1,
        missingFields: ["task"],
        reason: error instanceof Error ? error.message : "Block 解析失败",
        rawBlock: block,
      });
    }
  });
  return {
    rawOutput: raw,
    tasks,
    droppedReasons,
    droppedTaskIndices: droppedReasons.map((item) => item.index),
    warnings,
    rawBlocks,
  };
}

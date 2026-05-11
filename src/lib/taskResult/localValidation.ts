import type { Task } from "@/types/kiki";
import type { LocalValidationIssue, LocalValidationReport } from "@/types/taskAcceptance";
import type { ResultBlock, TaskResult } from "@/types/taskResult";

type DeliverableCheckLike = {
  matched?: boolean;
  missingDeliverables?: string[];
  criteriaResults?: Array<{ status?: string }>;
};

type ParsedResultLike = {
  summary?: string;
  finalMessage?: string;
  artifacts?: unknown[];
  taskResult?: TaskResult | null;
  deliverableCheck?: DeliverableCheckLike | null;
  awaitingUser?: boolean;
  interactionRequirement?: {
    type?: string;
    question?: string;
    reason?: string;
  };
};

export type ValidateTaskResultInput = {
  task: Task;
  rawOutput?: string;
  parsedResult?: ParsedResultLike | null;
  parseError?: string;
};

const ALLOWED_BLOCK_KINDS: ResultBlock["kind"][] = [
  "heading",
  "paragraph",
  "markdown",
  "list",
  "key_value",
  "comparison_table",
  "decision",
  "callout",
];

function issue(input: LocalValidationIssue): LocalValidationIssue {
  return input;
}

function hasText(value: unknown) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasArtifactContent(artifacts: unknown[] | undefined) {
  return Boolean(
    artifacts?.some((artifact) => {
      if (!artifact || typeof artifact !== "object") return false;
      const record = artifact as Record<string, unknown>;
      return hasText(record.label) || hasText(record.content) || hasText(record.href);
    }),
  );
}

function artifactReferencesLocalFile(artifacts: unknown[] | undefined) {
  return Boolean(
    artifacts?.some((artifact) => {
      if (!artifact || typeof artifact !== "object") return false;
      const record = artifact as Record<string, unknown>;
      const text = [record.content, record.href, record.label].filter((item): item is string => typeof item === "string").join("\n");
      return /(?:^|[\s：:])[^\\n]+\\.(md|markdown|txt|html|json)\\b/i.test(text);
    }),
  );
}

function hasReusableText(result?: ParsedResultLike | null) {
  return Boolean(
    result &&
      (hasText(result.summary) ||
        hasText(result.finalMessage) ||
        hasArtifactContent(result.artifacts)),
  );
}

function validateBlockSchema(block: ResultBlock): string | null {
  switch (block.kind) {
    case "heading":
      return hasText(block.text) && [1, 2, 3].includes(block.level) ? null : "heading 需要 text 和 level";
    case "paragraph":
      return hasText(block.text) ? null : "paragraph 需要 text";
    case "markdown":
      return hasText(block.content) ? null : "markdown 需要 content";
    case "list":
      return Array.isArray(block.items) && block.items.length > 0 ? null : "list 需要非空 items";
    case "key_value":
      return Array.isArray(block.entries) && block.entries.length > 0 ? null : "key_value 需要非空 entries";
    case "comparison_table":
      return Array.isArray(block.columns) && block.columns.length > 0 && Array.isArray(block.rows) && block.rows.length > 0
        ? null
        : "comparison_table 需要非空 columns 和 rows";
    case "decision":
      return hasText(block.question) && Array.isArray(block.options) && block.options.length > 0
        ? null
        : "decision 需要 question 和 options";
    case "callout":
      return hasText(block.text) ? null : "callout 需要 text";
    default:
      return "不支持的 block 类型";
  }
}

function inferRepairMode(issues: LocalValidationIssue[]): LocalValidationReport["repairMode"] {
  if (issues.some((item) => item.code === "json_parse_failed")) return "format_repair";
  if (issues.some((item) => item.code === "blocked_state_invalid")) return "state_repair";
  if (issues.some((item) => item.code === "artifact_only" || item.code === "empty_blocks" || item.code === "missing_required_blocks")) {
    return "presentation_repair";
  }
  if (issues.some((item) => item.code === "missing_task_result" || item.code === "invalid_block_schema" || item.code === "deliverable_check_invalid")) {
    return "structure_repair";
  }
  return "content_completion";
}

function requiredBlocks(task: Task): ResultBlock["kind"][] {
  return task.expectedResult?.requiredBlocks ?? [];
}

export function validateTaskResultLocally(input: ValidateTaskResultInput): LocalValidationReport {
  const result = input.parsedResult;
  const issues: LocalValidationIssue[] = [];

  if (input.parseError) {
    issues.push(issue({
      code: "json_parse_failed",
      severity: "critical",
      message: "Claude 输出不是可解析的任务结果 JSON。",
      evidence: input.parseError,
      repairHint: "只修复 JSON 格式，并把原始输出中的有效内容整理进 task_result.blocks。",
    }));
  }

  if (!result?.taskResult) {
    issues.push(issue({
      code: "missing_task_result",
      severity: "critical",
      message: "结果缺少 task_result。",
      repairHint: "根据已有 summary、final_message 或 artifacts 生成完整 task_result。",
    }));
  }

  const blocks = result?.taskResult?.blocks ?? [];
  if (result?.taskResult && blocks.length === 0 && !result.awaitingUser) {
    issues.push(issue({
      code: "empty_blocks",
      severity: "critical",
      message: "task_result.blocks 为空，无法展示主产出。",
      repairHint: "把已有内容整理为可展示 blocks。",
    }));
  }

  if (!result?.taskResult && hasReusableText(result)) {
    issues.push(issue({
      code: "artifact_only",
      severity: "critical",
      message: "结果只有 artifact、summary 或 final_message，没有组件化主产出。",
      repairHint: "把已有产出转换为 task_result.blocks。",
    }));
  }

  const invalidBlocks = blocks
    .map((block, index) => ({ index, block, error: validateBlockSchema(block) }))
    .filter((item) => item.error);
  if (invalidBlocks.length > 0) {
    issues.push(issue({
      code: "invalid_block_schema",
      severity: "major",
      message: "部分 block 结构不符合系统支持的字段。",
      evidence: invalidBlocks.map((item) => `#${item.index + 1} ${item.block.kind}: ${item.error}`).join("\n"),
      repairHint: "保留内容，只修正 block kind 和字段结构。",
    }));
  }

  const missingRequiredBlocks = requiredBlocks(input.task).filter((kind) => !blocks.some((block) => block.kind === kind));
  if (!result?.awaitingUser && missingRequiredBlocks.length > 0) {
    issues.push(issue({
      code: "missing_required_blocks",
      severity: "major",
      message: "结果缺少任务要求的 block 类型。",
      evidence: missingRequiredBlocks.join("、"),
      repairHint: "补齐缺失 blocks，并确保承载真实产出内容。",
    }));
  }

  if (result?.awaitingUser) {
    const type = result.interactionRequirement?.type;
    if (type !== "provide_context" && type !== "answer" && type !== "perform_offline_action" && type !== "confirm") {
      issues.push(issue({
        code: "blocked_state_invalid",
        severity: "major",
        message: "awaitingUser 为 true，但交互类型不完整或不一致。",
        repairHint: "如果需要用户补充，设置明确的 interaction_requirement；否则返回完整 task_result.blocks。",
      }));
    }
  }

  const deliverableCheck = result?.deliverableCheck;
  if (!result?.awaitingUser && (!deliverableCheck || typeof deliverableCheck.matched !== "boolean")) {
    issues.push(issue({
      code: "deliverable_check_invalid",
      severity: "major",
      message: "结果缺少有效的 deliverable_check。",
      repairHint: "根据修复后的 task_result.blocks 重新填写 deliverable_check。",
    }));
  }

  const passed = issues.length === 0;
  return {
    passed,
    repairMode: inferRepairMode(issues),
    allowToolCalls:
      (issues.some((item) => item.code === "missing_required_blocks") && !hasReusableText(result)) ||
      artifactReferencesLocalFile(result?.artifacts),
    issues,
    reusableContent: {
      summary: result?.summary,
      finalMessage: result?.finalMessage,
      artifacts: result?.artifacts,
      taskResult: result?.taskResult ?? undefined,
    },
  };
}

export function allowedBlockKinds() {
  return ALLOWED_BLOCK_KINDS;
}

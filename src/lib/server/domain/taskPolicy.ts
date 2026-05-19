import type { Task, TaskExpectedResult, TaskRunErrorCategory } from "@/types/kiki";

type ConfirmationPolicyInput =
  | Pick<Task, "expectedResult" | "requiresConfirmation" | "collaboration">
  | {
      expectedOutputType?: TaskExpectedResult["type"];
      completionCriteria?: string;
      requiresConfirmation?: boolean;
      completionOwner?: NonNullable<Task["collaboration"]>["completionOwner"];
    };

type ConfirmationPolicyOptions = {
  includeRequiresConfirmation?: boolean;
  includeUserCompletionOwner?: boolean;
};

const USER_CONFIRMATION_COMPLETION_PATTERN =
  /用户.*(确认|审批|选择|决定|采纳).*完成|必须.*用户.*(确认|审批|选择|决定|采纳)|经用户.*(确认|审批|选择|决定|采纳)/;

function expectedResultType(input: ConfirmationPolicyInput) {
  if ("expectedResult" in input) return input.expectedResult?.type;
  return "expectedOutputType" in input ? input.expectedOutputType : undefined;
}

function completionCriteria(input: ConfirmationPolicyInput) {
  if ("expectedResult" in input) return input.expectedResult?.completionCriteria;
  return "completionCriteria" in input ? input.completionCriteria : undefined;
}

function requiresConfirmationFlag(input: ConfirmationPolicyInput) {
  return "requiresConfirmation" in input ? input.requiresConfirmation : undefined;
}

function completionOwner(input: ConfirmationPolicyInput) {
  if ("collaboration" in input) return input.collaboration?.completionOwner;
  return "completionOwner" in input ? input.completionOwner : undefined;
}

export function requiresUserConfirmationToComplete(
  input: ConfirmationPolicyInput,
  options: ConfirmationPolicyOptions = {},
) {
  const expectedType = expectedResultType(input);
  if (expectedType === "decision" || expectedType === "confirmation") return true;
  if (USER_CONFIRMATION_COMPLETION_PATTERN.test(completionCriteria(input) ?? "")) return true;
  if (options.includeRequiresConfirmation && requiresConfirmationFlag(input) === true && expectedType !== "information") {
    return true;
  }
  if (options.includeUserCompletionOwner && completionOwner(input) === "user" && expectedType !== "information") {
    return true;
  }
  return false;
}

export function classifyTaskRunError(error: unknown): TaskRunErrorCategory {
  const message = error instanceof Error ? error.message : String(error);
  if (/abort|中断|cancel/i.test(message)) return "aborted";
  if (/permission|权限|accept/i.test(message)) return "permission";
  if (/network|fetch|ECONN|timed out|timeout|socket/i.test(message)) return "transient_network";
  if (/spawn|ENOENT|启动失败|cli/i.test(message)) return "transient_cli";
  if (/json|parse|格式|schema/i.test(message)) return "logic";
  return "unknown";
}

import { buildJsonRepairPrompt } from "@/lib/server/claude/jsonRepair";
import { buildLocalValidationRepairPrompt } from "@/lib/server/goalTaskAcceptancePrompt";
import { validateTaskResultLocally } from "@/lib/taskResult/localValidation";
import { normalizeTaskResultViewKind } from "@/types/kiki";
import type { Goal, SubGoal, Task, TaskInstance } from "@/types/kiki";
import type { RuntimeEnvironment } from "@/types/runtime";
import type { ExecutionTrajectoryStep } from "@/types/executionTrajectory";
import type { LocalValidationReport, TaskAcceptanceRuntimeState } from "@/types/taskAcceptance";
import type { ParsedTaskRunnerResult } from "./taskRunnerTypes";
import {
  awaitingCtxFrom,
  buildAwaitingConfirmationFromRaw,
} from "./awaitingUserResolver";
import {
  taskParserCtxFrom,
  tryParseTaskRunnerResult,
} from "./taskResultParser";
import type { TaskClaudePort } from "./taskClaudePort";

/**
 * localRepairCycle —— 本地校验失败后的"调 Claude 修复 → 重解析"循环,
 * 最多两轮。属于编排层(纯函数+调端口),不与具体 telemetry/IO 耦合。
 *
 * input 收窄为运行本轮修复真正需要的字段:goal/subGoal/task/instance/
 * runtimeEnv/signal + workspace 目录与 requestId(用于 parser 兜底快照)。
 * 没传整个 RunGoalTaskInput——这就是"接口即测试面":测试构造一个最小
 * 输入对象 + 假 TaskClaudePort 即可端到端驱动修复链。
 */
export type LocalRepairCycleInput = {
  goal: Goal;
  subGoal: SubGoal;
  task: Task;
  instance: TaskInstance;
  runtimeEnv: RuntimeEnvironment;
  signal?: AbortSignal;
  resumeContext?: string;
  conversationWorkspaceDir?: string;
  taskWorkspaceDir?: string;
  requestId: string;
};

export type LocalRepairCycleState = {
  rawOutput: string;
  parsedResult: ParsedTaskRunnerResult | null;
  parseError?: string;
  runtime: TaskAcceptanceRuntimeState;
  appendTrajectory: (step: Omit<ExecutionTrajectoryStep, "id" | "index" | "startedAt"> & { startedAt?: string }) => ExecutionTrajectoryStep[];
};

export type LocalRepairCycleResult = {
  rawOutput: string;
  parsedResult: ParsedTaskRunnerResult | null;
  parseError?: string;
  localValidationReport: LocalValidationReport;
};

function taskRequiresAfterOutputConfirmation(task: Task) {
  return (
    task.requiresConfirmation === true ||
    (task.collaboration?.mode === "agent_with_user_confirmation" &&
      task.collaboration.userInteractionTiming === "after_agent_output" &&
      task.collaboration.userInteractionType === "confirm")
  );
}

function looksLikeUnstructuredConfirmationOutput(task: Task, rawOutput: string, parseError?: string) {
  if (!parseError || !rawOutput.trim() || !taskRequiresAfterOutputConfirmation(task)) return false;
  return /用户确认|请用户确认|让用户确认|等待用户|确认选择|确认签证|选择.*方案|候选方案|对比分析|推荐方案/.test(rawOutput);
}

export async function runLocalRepairCycle(
  input: LocalRepairCycleInput,
  state: LocalRepairCycleState,
  port: TaskClaudePort,
): Promise<LocalRepairCycleResult> {
  let rawOutput = state.rawOutput;
  let parsedResult = state.parsedResult;
  let parseError = state.parseError;
  if (!parsedResult && looksLikeUnstructuredConfirmationOutput(input.task, rawOutput, parseError)) {
    parsedResult = buildAwaitingConfirmationFromRaw(awaitingCtxFrom(input), rawOutput);
    parseError = undefined;
    state.appendTrajectory({
      type: "approval",
      status: "awaiting_user",
      title: "识别到用户确认节点",
      thought: "Agent 返回了非 JSON 格式的确认卡片内容，系统已兜底转换为 awaiting_user，等待用户确认。",
    });
  }
  let lastReport = validateTaskResultLocally({
    task: input.task,
    rawOutput,
    parsedResult,
    parseError,
  });

  for (let attempt = 1; attempt <= 2 && !lastReport.passed; attempt += 1) {
    // 中止后停止本地校验修复轮次，避免无谓的 CLI 调用与副作用。
    if (input.signal?.aborted) {
      throw new Error("任务已被中止（超时或 lease 失效），停止本地修复");
    }
    const isFormatRepair = lastReport.issues.length === 1 && lastReport.issues[0]?.code === "json_parse_failed";
    state.runtime.localValidationReports.push(lastReport);
    state.runtime.repairAttempts.push({
      type: "local_validation",
      attempt,
      promptKind: isFormatRepair ? "json_character_repair" : "local_validation_repair",
      startedAt: new Date().toISOString(),
      status: "running",
      issueCodes: lastReport.issues.map((item) => item.code),
    });
    state.appendTrajectory({
      type: "system",
      status: "running",
      title: isFormatRepair ? `JSON 解析失败，开始第 ${attempt} 次字符级修复` : `本地校验未通过，开始第 ${attempt} 次结构修复`,
      thought: lastReport.issues.map((item) => `${item.code}: ${item.message}`).join("\n"),
    });
    const repairPrompt = isFormatRepair
      ? buildJsonRepairPrompt(rawOutput)
      : buildLocalValidationRepairPrompt({
          goal: input.goal,
          subGoal: input.subGoal,
          task: input.task,
          instance: input.instance,
          rawAgentOutput: rawOutput,
          parsedResult,
          report: lastReport,
        });
    const repairedOutput = await port.runClaude(repairPrompt, lastReport.allowToolCalls ? input.runtimeEnv.permissionMode : "readonly");
    rawOutput = repairedOutput.finalMessage;
    let parsed = tryParseTaskRunnerResult(taskParserCtxFrom(input), rawOutput, normalizeTaskResultViewKind(input.task.resultViewKind ?? input.task.executionKind));
    if (!parsed.result && repairedOutput.fallbackMessage.trim()) {
      const fallbackParsed = tryParseTaskRunnerResult(
        taskParserCtxFrom(input),
        repairedOutput.fallbackMessage,
        normalizeTaskResultViewKind(input.task.resultViewKind ?? input.task.executionKind),
      );
      if (fallbackParsed.result) {
        rawOutput = repairedOutput.fallbackMessage;
        parsed = fallbackParsed;
        state.appendTrajectory({
          type: "system",
          status: "completed",
          title: "已从修复流式事件回填结果",
          thought: "修复轮 result.result 解析失败，系统已使用 Claude stream 中聚合的 assistant 内容恢复结构化结果。",
        });
      }
    }
    parsedResult = parsed.result;
    parseError = parsed.error;
    lastReport = validateTaskResultLocally({
      task: input.task,
      rawOutput,
      parsedResult,
      parseError,
    });
    const runtimeAttempt = state.runtime.repairAttempts[state.runtime.repairAttempts.length - 1];
    if (runtimeAttempt) {
      runtimeAttempt.finishedAt = new Date().toISOString();
      runtimeAttempt.status = lastReport.passed ? "passed" : "failed";
    }
  }

  state.runtime.localValidationReports.push(lastReport);
  return { rawOutput, parsedResult, parseError, localValidationReport: lastReport };
}

import assert from "node:assert/strict";
import {
  runLocalRepairCycle,
  type LocalRepairCycleInput,
  type LocalRepairCycleState,
} from "./localRepairCycle";
import type { ParsedTaskRunnerResult } from "./taskRunnerTypes";
import type { TaskClaudePort, TaskClaudePromptResult } from "./taskClaudePort";
import type { Goal, SubGoal, Task, TaskInstance } from "@/types/kiki";
import type { RuntimeEnvironment } from "@/types/runtime";
import type { TaskAcceptanceRuntimeState } from "@/types/taskAcceptance";

/**
 * localRepairCycle 的接口契约。这是整套深化最关键的 spec:
 * 注入假 TaskClaudePort 端到端驱动"调 Claude 修复 → 重解析"循环,
 * 不必碰真实 Claude——兑现"接口即测试面"承诺。
 */

function buildPort(responses: TaskClaudePromptResult[]): TaskClaudePort & { calls: Array<{ message: string; permissionMode: string }> } {
  const queue = [...responses];
  const calls: Array<{ message: string; permissionMode: string }> = [];
  return {
    calls,
    async runClaude(message, permissionMode) {
      calls.push({ message, permissionMode: permissionMode ?? "<none>" });
      const next = queue.shift();
      if (!next) throw new Error("fake port: 调用次数超出预设响应队列");
      return next;
    },
  };
}

function buildInput(overrides: Partial<LocalRepairCycleInput> = {}): LocalRepairCycleInput {
  return {
    goal: { id: "g1", title: "测试目标" } as unknown as Goal,
    subGoal: { id: "sg1", title: "测试子目标" } as unknown as SubGoal,
    task: {
      id: "t1",
      title: "测试任务",
      expectedOutcome: "可展示结果",
      expectedResult: { type: "deliverable", completionCriteria: "JSON 结构完整" },
      resultViewKind: "generic_result",
      executionKind: "generic_result",
    } as unknown as Task,
    instance: { id: "i1" } as unknown as TaskInstance,
    runtimeEnv: { permissionMode: "default" } as unknown as RuntimeEnvironment,
    requestId: "req-1",
    ...overrides,
  };
}

function buildState(overrides: Partial<LocalRepairCycleState> = {}): LocalRepairCycleState {
  const runtime: TaskAcceptanceRuntimeState = {
    localValidationReports: [],
    acceptanceReports: [],
    repairAttempts: [],
  };
  return {
    rawOutput: "",
    parsedResult: null,
    runtime,
    appendTrajectory: () => [],
    ...overrides,
  };
}

function validParsedResult(): ParsedTaskRunnerResult {
  return {
    summary: "已完成",
    finalMessage: "任务结果",
    resultViewKind: "generic_result",
    awaitingUser: false,
    artifacts: [],
    taskResult: {
      schemaVersion: 1,
      taskId: "t1",
      instanceId: "i1",
      title: "结果标题",
      status: "done",
      blocks: [{ kind: "paragraph", text: "OK" }],
      meta: { producedAt: "2026-06-21T00:00:00.000Z" },
    },
    deliverableCheck: {
      matched: true,
      confidence: "high",
      deliveredArtifacts: ["结果"],
      missingDeliverables: [],
      criteriaResults: [{ criterion: "JSON 结构完整", status: "passed" }],
    },
    interactionRequirement: {
      type: "none",
      timing: "not_required",
      reason: "",
      question: "",
      options: [],
      suggestedActions: [],
      shouldNotifyUser: false,
    },
    blocker: null,
    structuredOutput: null,
  };
}

export async function runLocalRepairCycleSpecs() {
  // 1. 已通过本地校验时不调端口
  {
    const port = buildPort([]);
    const result = await runLocalRepairCycle(
      buildInput(),
      buildState({ parsedResult: validParsedResult(), rawOutput: "valid raw" }),
      port,
    );
    assert.equal(port.calls.length, 0, "已通过校验时不应调端口");
    assert.equal(result.localValidationReport.passed, true);
    assert.ok(result.parsedResult);
  }

  // 2. 解析失败 + 不像非结构化确认 → 进入修复循环,调端口
  //    端口返回有效 JSON,第一次修复后校验通过
  {
    const validRaw = JSON.stringify({
      summary: "修复后完成",
      final_message: "OK",
      result_view_kind: "generic_result",
      task_result: {
        schemaVersion: 1,
        taskId: "t1",
        instanceId: "i1",
        title: "结果",
        status: "done",
        blocks: [{ kind: "paragraph", text: "OK" }],
        meta: { producedAt: "2026-06-21T00:00:00.000Z" },
      },
      deliverable_check: {
        matched: true,
        confidence: "high",
        delivered_artifacts: ["结果"],
        missing_deliverables: [],
        criteria_results: [{ criterion: "JSON 结构完整", status: "passed" }],
      },
    });
    const port = buildPort([{ finalMessage: validRaw, fallbackMessage: "" }]);
    const result = await runLocalRepairCycle(
      buildInput(),
      buildState({
        parsedResult: null,
        rawOutput: "不是合法 JSON",
        parseError: "JSON parse error",
      }),
      port,
    );
    assert.ok(port.calls.length >= 1, "解析失败应至少调一次端口");
    assert.equal(result.localValidationReport.passed, true, "修复后应通过校验");
    assert.ok(result.parsedResult, "应有 parsedResult");
    assert.equal(result.parsedResult?.summary, "修复后完成");
  }

  // 3. 端口连续返回无效响应 → 修复两轮后仍失败,优雅返回(不抛)
  {
    const port = buildPort([
      { finalMessage: "still invalid 1", fallbackMessage: "" },
      { finalMessage: "still invalid 2", fallbackMessage: "" },
    ]);
    const result = await runLocalRepairCycle(
      buildInput(),
      buildState({
        parsedResult: null,
        rawOutput: "invalid",
        parseError: "parse error",
      }),
      port,
    );
    assert.equal(port.calls.length, 2, "应调两轮修复");
    assert.equal(result.localValidationReport.passed, false, "两轮后仍失败");
  }

  // 4. signal 已 abort → 进入循环前抛出,不调端口
  {
    const port = buildPort([]);
    const abortedSignal = AbortSignal.abort();
    let threw = false;
    try {
      await runLocalRepairCycle(
        buildInput({ signal: abortedSignal }),
        buildState({
          parsedResult: null,
          rawOutput: "invalid",
          parseError: "parse error",
        }),
        port,
      );
    } catch (error) {
      threw = true;
      assert.ok(error instanceof Error);
      assert.ok((error as Error).message.includes("中止"));
    }
    assert.equal(threw, true, "abort 后应抛错");
    assert.equal(port.calls.length, 0, "abort 后不应调端口");
  }

  // 5. 非结构化确认输出兜底:task 要求 after_output 确认 + raw 含确认关键词
  //    → 在进修复前会先把 raw 转 awaiting 结果(buildAwaitingConfirmationFromRaw),
  //    随后是否继续修复取决于该 awaiting 结果能否通过本地校验,这里只断言:
  //    (a) 兜底确实被走到——结果带有 recoveredFromUnstructuredConfirmation 标记或
  //        awaitingUser=true 的 confirm 交互,且 trajectory 收到 approval 记录。
  {
    const trajectorySteps: Array<Record<string, unknown>> = [];
    const port = buildPort([
      { finalMessage: "{}", fallbackMessage: "" },
      { finalMessage: "{}", fallbackMessage: "" },
    ]);
    const state = buildState({
      parsedResult: null,
      rawOutput: "我已生成两个签证方案,请用户确认选择哪一个。",
      parseError: "not json",
      appendTrajectory: (step) => {
        trajectorySteps.push(step as Record<string, unknown>);
        return [];
      },
    });
    await runLocalRepairCycle(
      buildInput({
        task: {
          id: "t1",
          title: "签证方案选择",
          expectedOutcome: "选定签证方案",
          expectedResult: { type: "deliverable", completionCriteria: "..." },
          resultViewKind: "generic_result",
          executionKind: "generic_result",
          requiresConfirmation: true,
        } as unknown as Task,
      }),
      state,
      port,
    );
    const sawApproval = trajectorySteps.some((step) => step.type === "approval" && step.status === "awaiting_user");
    assert.equal(sawApproval, true, "非结构化兜底应在 trajectory 写入 approval 节点");
  }

  // 6. permissionMode 传递:lastReport.allowToolCalls 决定 readonly vs runtimeEnv 模式
  //    (本测试用初始无 parsedResult + parseError 触发修复,permissionMode 取 readonly,
  //     因 json_parse_failed 时 allowToolCalls 通常为 false)
  {
    const port = buildPort([
      { finalMessage: "{}", fallbackMessage: "" },
      { finalMessage: "{}", fallbackMessage: "" },
    ]);
    await runLocalRepairCycle(
      buildInput({ runtimeEnv: { permissionMode: "acceptEdits" } as unknown as RuntimeEnvironment }),
      buildState({
        parsedResult: null,
        rawOutput: "invalid",
        parseError: "parse error",
      }),
      port,
    );
    assert.ok(port.calls.length >= 1);
    // json_parse_failed 时 lastReport.allowToolCalls 强制为 false(见 localValidation.ts),
    // 故 permissionMode 必须收窄成 "readonly"——不能透传 runtimeEnv.permissionMode (acceptEdits)。
    // 若未来该收窄逻辑被反转,本断言会立刻报错。
    assert.equal(
      port.calls[0].permissionMode,
      "readonly",
      `parse 错误下 permissionMode 必须收窄为 readonly, 实际: ${port.calls[0].permissionMode}`,
    );
  }

  console.log("localRepairCycle specs passed");
}

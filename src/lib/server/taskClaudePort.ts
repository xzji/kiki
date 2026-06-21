import type { RuntimeEnvironment } from "@/types/runtime";

/**
 * TaskClaudePort —— 编排层(repair/acceptance 链,未来含就绪检查)调用 Claude 的窄端口。
 *
 * 端口面只含编排层真正关心的业务参数:message + permissionMode。执行配置
 * (runtimeEnv / 工作目录 / signal / agentRunId / telemetry / tool-permission 副作用)
 * 被真实适配器吞在闭包里,编排层不可见——从而可注入假端口端到端驱动
 * "修复→重解析→判接受度"链,不碰真实 Claude。
 *
 * 返回值对齐 runClaudePromptWithFallback 的真实产物:finalMessage 为主结果,
 * fallbackMessage 为 CLI 降级时回退文本。无 trajectory(trajectory 由编排层
 * 自行通过 appendTrajectory 维护,不属于 Claude 调用的产物)。
 */
export type TaskClaudePromptResult = {
  finalMessage: string;
  fallbackMessage: string;
};

export type TaskClaudePort = {
  runClaude(message: string, permissionMode: RuntimeEnvironment["permissionMode"]): Promise<TaskClaudePromptResult>;
};

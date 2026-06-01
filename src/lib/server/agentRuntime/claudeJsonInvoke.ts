/**
 * claudeJsonInvoke — Topic 初始化 Saga / Thread Runner 共用的 LlmInvoke 实现。
 *
 * Plan ref: §3.1.4 + §9.5（决策/展示拆分硬约束）。
 *
 * 设计要点：
 * 1. 仅服务端使用：transport 层依赖 spawn / fs，不应在客户端 import。
 * 2. 决策层调用走 runPromptJson + parseJsonWithCandidates，含 jsonRepair 链路；
 *    展示层调用（fire-and-forget）由调用方自行使用 runPromptText，本模块不强耦合。
 * 3. 失败时 throw Error，由 agentExecutor 捕获后写 error 事件并标记 run failed。
 *
 * 与 agentExecutor.LlmInvoke 类型契约对齐：
 *   request: { agentRunId; prompt; context }
 *   result:  { rawText; parsed?; meta? }
 */

import type { RuntimeEnvironment } from "@/types/runtime";

import {
  buildJsonParseCandidates,
  normalizeClaudeJsonText,
  parseJsonWithCandidates,
} from "@/lib/server/claude/jsonRepair";
import { runPromptJson, runPromptText } from "@/lib/server/claude/transport";
import type { LlmInvoke } from "@/lib/server/agentRuntime/agentExecutor";

export type CreateClaudeJsonInvokeInput<T> = {
  /** Caller-supplied JSON validator. Throws on invalid shape. */
  validator: (value: unknown) => T;
  /** Working directory for the Claude CLI subprocess. */
  cwd: string;
  /** Runtime environment (cliPath / permissionMode / filePolicy). */
  runtimeEnv: RuntimeEnvironment;
  /** Optional abort signal forwarded to the CLI subprocess. */
  signal?: AbortSignal;
  /** Optional fallback parsed payload when validator fails (saga 决策保守降级). */
  degradedFallback?: (raw: string, error: unknown) => T | undefined;
};

/**
 * Create an LlmInvoke that returns parsed JSON for decision-layer roles.
 *
 * §9.5 双层拆分：决策层只关心 parsed；展示层另用 runPromptText 异步生成。
 */
export function createClaudeJsonInvoke<T>(input: CreateClaudeJsonInvokeInput<T>): LlmInvoke {
  return async (request) => {
    const result = await runPromptJson({
      prompt: request.prompt,
      runtimeEnv: input.runtimeEnv,
      cwd: input.cwd,
      abortSignal: input.signal,
      traceContext: {
        scope: "topic_init_saga",
        stepLabel: typeof request.context?.role === "string" ? request.context.role : undefined,
      },
    });

    const primary = normalizeClaudeJsonText(result.raw);
    const attempt = parseJsonWithCandidates<T>(
      buildJsonParseCandidates(primary),
      input.validator,
    );

    if (attempt.ok) {
      return {
        rawText: primary,
        parsed: attempt.parsed as unknown as Record<string, unknown>,
        meta: {
          elapsedMs: result.elapsedMs,
          exitCode: result.exitCode,
          strategy: attempt.strategy,
        },
      };
    }

    if (input.degradedFallback) {
      const fallback = input.degradedFallback(primary, attempt.error);
      if (fallback !== undefined) {
        return {
          rawText: primary,
          parsed: fallback as unknown as Record<string, unknown>,
          meta: {
            elapsedMs: result.elapsedMs,
            exitCode: result.exitCode,
            degraded: true,
            fallbackReason: attempt.error instanceof Error ? attempt.error.message : String(attempt.error),
          },
        };
      }
    }

    throw attempt.error instanceof Error
      ? attempt.error
      : new Error(`claudeJsonInvoke: parse failed (${String(attempt.error)})`);
  };
}

/**
 * Create an LlmInvoke that returns raw text only (no JSON parsing).
 * Used by Presenter 的展示层 fire-and-forget 调用。
 */
export function createClaudeTextInvoke(input: {
  cwd: string;
  runtimeEnv: RuntimeEnvironment;
  signal?: AbortSignal;
}): LlmInvoke {
  return async (request) => {
    const result = await runPromptText({
      prompt: request.prompt,
      runtimeEnv: input.runtimeEnv,
      cwd: input.cwd,
      abortSignal: input.signal,
      traceContext: {
        scope: "topic_init_saga_presentation",
        stepLabel: typeof request.context?.role === "string" ? request.context.role : undefined,
      },
    });
    return {
      rawText: result.raw,
      meta: { elapsedMs: result.elapsedMs, exitCode: result.exitCode },
    };
  };
}

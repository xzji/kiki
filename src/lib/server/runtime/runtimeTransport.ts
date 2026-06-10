import { getRuntimeAdapter } from "@/lib/server/runtime/adapters/registry";
import type {
  RuntimePromptJsonInput,
  RuntimePromptTextInput,
  RuntimeStreamOptions,
} from "@/lib/server/runtime/adapters/types";

export function streamRuntimePrompt(options: RuntimeStreamOptions) {
  // resume session 的 runtime 归属由数据模型保证：服务端按 runtimeKind 从 runtimeSessions 解析，
  // 不同 CLI 各自独立分键，不会串号，因此传输层无需再做前缀兜底。
  return getRuntimeAdapter(options.runtimeKind).streamPrompt(options);
}

export function runRuntimePromptJson(input: RuntimePromptJsonInput) {
  return getRuntimeAdapter(input.runtimeEnv.runtimeKind).runPromptJson(input);
}

export function runRuntimePromptText(input: RuntimePromptTextInput) {
  return getRuntimeAdapter(input.runtimeEnv.runtimeKind).runPromptText(input);
}

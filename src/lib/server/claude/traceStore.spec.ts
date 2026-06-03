import assert from "node:assert/strict";

import { ensureIsolatedPlanningSpecDataDir } from "@/lib/server/runtime/stateSnapshot.spec";
import { ensureConversationWorkspace } from "@/lib/server/workspace/conversationWorkspace";

import { createClaudeTrace } from "./traceStore";

export function runClaudeTraceStoreSpecs() {
  ensureIsolatedPlanningSpecDataDir();
  const env = process.env as Record<string, string | undefined>;
  const previousNodeEnv = env.NODE_ENV;
  env.NODE_ENV = "development";
  try {
    const workspace = ensureConversationWorkspace("conv-trace-saga-spec");
    const trace = createClaudeTrace({
      cwd: workspace.workspaceDir,
      cliPath: "/bin/claude",
      args: ["--print"],
      scope: "topic_init_saga",
      stepLabel: "interviewer",
    });

    assert.ok(trace, "conversation workspace cwd should create a Claude trace");
    assert.match(trace.relativeTraceDir, /logs\/claude-traces/);
    trace.writePrompt("prompt");
    trace.writeOutput("{\"ok\":true}");
    trace.finish("completed");

    const noWorkspaceTrace = createClaudeTrace({
      cwd: process.cwd(),
      cliPath: "/bin/claude",
      args: ["--print"],
      scope: "topic_init_saga",
      stepLabel: "interviewer",
    });
    assert.equal(noWorkspaceTrace, null, "project root cwd should not create a workspace trace");
  } finally {
    if (previousNodeEnv === undefined) {
      delete env.NODE_ENV;
    } else {
      env.NODE_ENV = previousNodeEnv;
    }
  }
}

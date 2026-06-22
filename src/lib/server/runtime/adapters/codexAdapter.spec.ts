import assert from "node:assert/strict";

import {
  buildCodexArgs,
  buildCodexAttachmentPromptNote,
  buildCodexEnv,
  consumeCodexJsonLine,
  createCodexParseState,
  extractCodexFinalMessage,
  mapCodexSandbox,
} from "@/lib/server/runtime/adapters/codexAdapter";

export function runCodexAdapterSpecs() {
  assert.equal(mapCodexSandbox("readonly"), "read-only");
  assert.equal(mapCodexSandbox("execute"), "workspace-write");
  assert.equal(mapCodexSandbox("confirm"), "read-only");

  assert.deepEqual(
    buildCodexArgs({
      cwd: "/tmp/project",
      prompt: "hello",
      permissionMode: "readonly",
    }),
    [
      "exec",
      "--json",
      "--color",
      "never",
      "--cd",
      "/tmp/project",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "-c",
      "approval_policy=\"never\"",
      "hello",
    ],
  );

  assert.deepEqual(
    buildCodexArgs({
      cwd: "/tmp/project",
      prompt: "continue",
      permissionMode: "execute",
      resumeSessionId: "thread-1",
      imagePaths: ["/tmp/image.png"],
    }),
    [
      "exec",
      "resume",
      "thread-1",
      "--json",
      "--skip-git-repo-check",
      "-c",
      "sandbox_mode=\"workspace-write\"",
      "-c",
      "approval_policy=\"never\"",
      "--image",
      "/tmp/image.png",
      "continue",
    ],
  );

  // resume 分支绝不能包含 --sandbox/--color/--cd，否则 codex exec resume 会报 unexpected argument。
  const resumeArgs = buildCodexArgs({
    cwd: "/tmp/project",
    prompt: "go",
    permissionMode: "readonly",
    resumeSessionId: "thread-2",
  });
  assert.equal(resumeArgs.includes("--sandbox"), false);
  assert.equal(resumeArgs.includes("--color"), false);
  assert.equal(resumeArgs.includes("--cd"), false);
  assert.ok(resumeArgs.includes("sandbox_mode=\"read-only\""));

  const healthArgs = buildCodexArgs({
    cwd: "/tmp/project",
    prompt: "ok",
    permissionMode: "readonly",
    ephemeral: true,
  });
  assert.ok(healthArgs.includes("--ephemeral"));

  const normalArgs = buildCodexArgs({
    cwd: "/tmp/project",
    prompt: "ok",
    permissionMode: "readonly",
  });
  assert.equal(normalArgs.includes("--ephemeral"), false);

  const state = createCodexParseState();
  const events: Array<{ type: string; [key: string]: unknown }> = [];
  const emit = (event: { type: string; [key: string]: unknown }) => {
    events.push(event);
    return true;
  };
  // 真实 codex exec --json 信封：thread.started + item.* 包裹 + turn.failed。
  consumeCodexJsonLine(JSON.stringify({ type: "thread.started", thread_id: "thread-1" }), state, emit);
  consumeCodexJsonLine(JSON.stringify({ type: "turn.started" }), state, emit);
  consumeCodexJsonLine(JSON.stringify({ type: "item.started", item: { id: "cmd-1", type: "command_execution", command: "cat package.json" } }), state, emit);
  consumeCodexJsonLine(JSON.stringify({ type: "item.completed", item: { id: "cmd-1", type: "command_execution", command: "cat package.json", exit_code: 0 } }), state, emit);
  // 瞬时重连提示：仅记录，不作为 error 事件下发。
  consumeCodexJsonLine(JSON.stringify({ type: "error", message: "Reconnecting... 2/5" }), state, emit);
  consumeCodexJsonLine("{malformed", state, emit);
  consumeCodexJsonLine(JSON.stringify({ type: "item.completed", item: { id: "msg-1", type: "agent_message", text: "final ok" } }), state, emit);

  assert.equal(state.sessionId, "thread-1");
  assert.equal(state.finalMessage, "final ok");
  assert.ok(events.some((event) => event.type === "session" && event.sessionId === "thread-1"));
  assert.ok(events.some((event) => event.type === "status" && event.status === "running"));
  assert.ok(events.some((event) => event.type === "tool_call"));
  assert.ok(events.some((event) => event.type === "tool_result" && event.ok === true));
  // 重连提示不得渲染为用户可见错误事件。
  assert.equal(events.some((event) => event.type === "error"), false);

  // 失败轮：turn.failed 必须下发 error 事件并取 nested error.message。
  const failState = createCodexParseState();
  const failEvents: Array<{ type: string; [key: string]: unknown }> = [];
  consumeCodexJsonLine(
    JSON.stringify({ type: "turn.failed", error: { message: "boom" } }),
    failState,
    (event) => {
      failEvents.push(event);
      return true;
    },
  );
  assert.equal(failState.lastError, "boom");
  assert.ok(failEvents.some((event) => event.type === "error" && event.message === "boom"));

  // 命令失败：exit_code 非 0 → tool_result.ok=false。
  const toolFailState = createCodexParseState();
  const toolFailEvents: Array<{ type: string; [key: string]: unknown }> = [];
  consumeCodexJsonLine(
    JSON.stringify({ type: "item.completed", item: { id: "cmd-x", type: "command_execution", command: "false", exit_code: 1 } }),
    toolFailState,
    (event) => {
      toolFailEvents.push(event);
      return true;
    },
  );
  assert.ok(toolFailEvents.some((event) => event.type === "tool_result" && event.ok === false));

  const stdout = [
    JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "final ok" } }),
  ].join("\n");
  assert.equal(extractCodexFinalMessage(stdout), "final ok");

  const env = buildCodexEnv({
    HOME: "/home/user",
    PATH: "/bin",
    CODEX_API_KEY: "codex-key",
    CODEX_ACCESS_TOKEN: "codex-token",
    OPENAI_API_KEY: "openai-key",
    HTTPS_PROXY: "https://proxy",
    SSL_CERT_FILE: "/tmp/cert.pem",
    NEXT_RUNTIME: "edge",
    npm_lifecycle_event: "dev",
    TRAE_INTERNAL: "1",
  });
  assert.equal(env.HOME, "/home/user");
  assert.equal(env.PATH, "/bin");
  assert.equal(env.CODEX_API_KEY, "codex-key");
  assert.equal(env.CODEX_ACCESS_TOKEN, "codex-token");
  assert.equal(env.OPENAI_API_KEY, "openai-key");
  assert.equal(env.HTTPS_PROXY, "https://proxy");
  assert.equal(env.SSL_CERT_FILE, "/tmp/cert.pem");
  assert.equal(env.NEXT_RUNTIME, undefined);
  assert.equal(env.npm_lifecycle_event, undefined);
  assert.equal(env.TRAE_INTERNAL, undefined);

  const note = buildCodexAttachmentPromptNote([
    {
      id: "img",
      filename: "screen.png",
      mime: "image/png",
      size: 10,
      contentBase64: "AA==",
    },
    {
      id: "pdf",
      filename: "doc.pdf",
      mime: "application/pdf",
      size: 20,
      contentBase64: "AA==",
    },
  ]);
  assert.match(note, /--image/);
  assert.match(note, /暂不支持二进制直传/);
}

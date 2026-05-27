# Claude Trace Dev 调试功能规划

## 背景

当前 Dev 演示层已有「后端日志」能力，可以查看目标规划和任务执行的阶段摘要。但当 Claude CLI 输出异常、JSON 修复失败、流式会话行为不符合预期时，摘要日志不足以定位根因。

需要新增一个 Dev-only 调试功能，把 Claude 真实运行现场完整展示出来，包括：

- 实际写入 Claude CLI `stdin` 的 prompt 原文
- Claude CLI `stdout` 原文
- Claude CLI `stderr` 原文
- CLI stream-json 暴露的 assistant/thinking 中间内容
- 最终 `result` / output 原文
- 解析后的事件摘要和运行元信息

## 目标

- 在 Dev 浮层中新增 `Claude Trace` 入口。
- 所有 Claude CLI 调用统一在 transport 层采集，不在业务层重复埋点。
- Trace 数据按会话 workspace 隔离落盘。
- UI 保持只读调试，不污染正式会话消息流。
- 保留原文，不对 prompt、thinking、output 做改写。

## 非目标

- 不展示模型未通过 Claude CLI 暴露的隐藏思维链。
- 不把 Trace 数据写入 Zustand/localStorage。
- 不在生产环境暴露 Trace API 或 UI。
- 不改变现有 Claude 调用协议、任务执行状态机或目标规划主流程。

## 数据目录

统一落盘到会话 workspace：

```text
data/workspaces/conversations/<conversationId>/logs/claude-traces/<timestamp>-<traceId>/
  metadata.json
  prompt.txt
  stdout.jsonl
  stderr.txt
  thinking.txt
  output.txt
  parsed-events.json
```

如果 Claude 调用发生在任务 workspace 中，需要向上找到包含 `workspace.json` 的会话根目录，再写入该根目录下的 `logs/claude-traces/`。

## 数据模型

```ts
type ClaudeTraceStatus = "running" | "completed" | "failed" | "aborted";

type ClaudeTraceMetadata = {
  traceId: string;
  conversationId?: string;
  requestId?: string;
  scope?: string;
  phase?: string;
  stepLabel?: string;
  status: ClaudeTraceStatus;
  startedAt: string;
  finishedAt?: string;
  elapsedMs?: number;
  cwd: string;
  cliPath: string;
  args: string[];
  permissionMode?: string;
  claudeSessionId?: string;
  promptPath: string;
  stdoutPath: string;
  stderrPath: string;
  thinkingPath: string;
  outputPath: string;
  parsedEventsPath: string;
  errorMessage?: string;
};
```

## 采集点

### `runPromptJson`

用于目标规划、JSON 生成和部分非流式 Claude 调用。

采集内容：

- `input.prompt` 写入 `prompt.txt`
- `stdout` 写入 `stdout.jsonl`
- `stderr` 写入 `stderr.txt`
- 若 stdout 是 JSON，提取 `result` 或 message text 到 `output.txt`
- 失败时记录 error message 和 stderr

### `streamPrompt`

用于自由会话流式输出。

采集内容：

- `promptInput` 写入 `prompt.txt`
- 每个 stdout chunk 追加到 `stdout.jsonl`
- stderr chunk 追加到 `stderr.txt`
- 每个解析后的 payload 追加到 `parsed-events.json`
- `payload.type === "assistant"` 中 CLI 暴露的 text/thinking 内容写入 `thinking.txt`
- `payload.type === "result"` 的 `result` 写入 `output.txt`

## API 设计

仅 Dev 环境可用：

```text
GET /api/dev/claude-traces?conversationId=&limit=50
GET /api/dev/claude-traces/[traceId]
DELETE /api/dev/claude-traces
```

第一阶段实现两个 GET 接口。

列表接口返回摘要，不返回大文本：

```ts
{
  traces: ClaudeTraceSummary[]
}
```

详情接口返回原文：

```ts
{
  trace: ClaudeTraceDetail
}
```

## UI 设计

在 `DevPanel` 中新增 `Claude Trace` 按钮，与「后端日志」同级。

弹窗结构：

- 左侧：Trace 列表，按时间倒序展示
- 右侧：详情区域
- 顶部：刷新按钮
- Tabs：
  - `Prompt`
  - `Thinking`
  - `Output`
  - `Raw JSONL`
  - `stderr`
  - `Metadata`

展示规则：

- 所有原文使用 `<pre>` 展示。
- 如果 `thinking.txt` 为空，显示“Claude CLI 本次没有暴露 thinking 原文”。
- running 状态下每 2 秒刷新一次。
- 支持一键复制当前 tab 原文。

## 安全与边界

- API 在非 development 环境返回 404。
- Trace 文件只读展示，不提供前端编辑。
- Trace 可能包含用户上下文、路径、文件内容和 prompt，严禁进入生产环境。
- 不将 Trace 内容写入浏览器持久化。

## 实施步骤

1. 新增 `src/lib/server/claude/traceStore.ts`
2. 在 `transport.ts` 的 `runPromptJson` 和 `streamPrompt` 中统一接入 trace writer
3. 新增 `/api/dev/claude-traces` 列表接口
4. 新增 `/api/dev/claude-traces/[traceId]` 详情接口
5. 新增 `ClaudeTracePanel` / `ClaudeTraceDialog`
6. 在 `DevPanel` 中新增入口
7. 执行 TypeScript/诊断检查

## 验收标准

- DevPanel 能打开 `Claude Trace` 弹窗。
- 触发一次 `/goal` 或普通 Claude 对话后，Trace 列表出现新记录。
- 详情中能看到真实 prompt 原文。
- 详情中能看到 Claude CLI stdout/stderr 原文。
- 若 CLI 输出 result，能在 `Output` tab 看到最终输出。
- 非 development 环境 API 不暴露。


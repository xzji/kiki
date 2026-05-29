# KiKi 普通会话 WebSearch 权限混淆根因与修复计划

## Summary

本计划目标是修复 KiKi 普通会话中把 Claude CLI 底层工具权限机制误描述为产品授权弹窗的问题。

结论需要更新：这不是会话 workspace 目录没有隔离导致的源码/数据串扰；但也不能再说“完全没有限制工具”。产品层没有显式禁用 `WebSearch/WebFetch`，可 Claude CLI 层确实拒绝了 `WebFetch` 的真实调用。根因是普通会话的 `execute` 被映射为 Claude CLI 的 `--permission-mode acceptEdits`，但 `acceptEdits` 并不等于允许所有工具，尤其不自动允许 `WebFetch/WebSearch`；同时普通会话在 `execute` 模式下没有传 `--allowedTools WebFetch,WebSearch`，所以 CLI 在真正收到合法 `WebFetch` 调用后返回了 `permission_denials`。

更准确地说，当前有两个问题叠加：

* 权限配置问题：我们以为 `execute` / `acceptEdits` 代表“工具可用”，但 Claude CLI 仍要求 `WebFetch` 授权；由于普通会话没有传 `--allowedTools`，联网工具会被 CLI 拒绝。

* 语义暴露问题：KiKi 把 Claude CLI 的授权方式直接告诉用户，例如 `allow WebFetch`、`/allow WebFetch`、编辑 `~/.claude/settings.json`，但这些并不是 KiKi 产品普通会话里的可操作路径。

换句话说：

* `WebSearch/WebFetch` 在工具列表里，说明模型知道有这些工具。

* 早期 `WebSearch` trace 中没有 `tool_use` / `tool_call`，说明那一轮它没有尝试调用。

* 最新 `WebFetch` trace 中有真实 `tool_use`，并在合法入参那次收到 CLI 层 `permission_denials`。

* “权限请求没有成功传到你那边”这句话仍然不准确，因为项目没有把 CLI permission denial 转成产品级授权 UI，所以用户看不到弹窗是产品桥接缺失，不是用户没操作。

修复方向：

* 在普通会话 prompt 中明确约束：不得向用户暴露 Claude CLI、工具名、permission mode、allowlist、`/config`、`allow WebSearch` 等底层机制。

* 为普通会话建立产品级能力描述和工具使用规则：只有真实收到工具事件/错误事件时，才能说明工具调用结果或失败原因。

* 修复普通会话的 Claude CLI 工具白名单：对普通会话显式传入 `--allowedTools Read,Glob,Grep,WebFetch,WebSearch`，让联网工具在 KiKi 会话中可直接使用。

* 对“用户要求试一下联网”的场景增加强约束：必须先实际尝试 `WebSearch` / `WebFetch`；如果 CLI 返回 permission denial，转换成产品级错误，不输出 Claude CLI 配置建议。

* 补齐协议层：如果未来真的需要权限确认，应从 Claude CLI 原始事件解析为明确的 `permission_request`，并由前端显示产品定义的权限 UI；否则不要让模型臆测弹窗。

## Current State Analysis

### 已确认的实际链路

* 普通会话入口在 `src/components/conversation/ConversationView.tsx`，发送消息时调用 `streamClaudeChat(...)`。

* API 路由 `src/app/api/claude/chat/route.ts` 创建会话 workspace 后调用 `streamClaudeCli(...)`，并传入：

  * `workingDirectory: workspace.workspaceDir`

  * `permissionMode: body.runtimeEnv.permissionMode`

  * `claudeSessionId: body.claudeSessionId`

  * `contextPack`

  * `workspacePolicy: body.workspaceMode || "conversation"`

* Claude CLI 启动逻辑在 `src/lib/server/claude/transport.ts`：

  * `execute` 被映射为 `--permission-mode acceptEdits`

  * `readonly` 才会额外追加 `--allowedTools Read,Glob,Grep,WebFetch,WebSearch`

  * `execute` / `confirm` 当前不追加 `--allowedTools`，因此 Claude CLI init 中会暴露完整工具集。

* 普通会话 prompt 由 `buildWorkspaceBoundPrompt(...)` 生成，只做了 workspace 目录边界声明，没有做产品权限语义边界声明。

* 上下文包 `src/lib/server/workspace/contextPack.ts` 只注入当前会话最近消息、目标摘要、引用消息，不注入项目源码或其他会话。

### 事故 trace 事实

相关 trace：

* `data/workspaces/conversations/conv-new-1779895225230/logs/claude-traces/2026-05-27T15-23-34-934Z-Claude_-trace-1779895414934-dudn91/metadata.json`

* `data/workspaces/conversations/conv-new-1779895225230/logs/claude-traces/2026-05-27T15-23-34-934Z-Claude_-trace-1779895414934-dudn91/prompt.txt`

* `data/workspaces/conversations/conv-new-1779895225230/logs/claude-traces/2026-05-27T15-23-34-934Z-Claude_-trace-1779895414934-dudn91/parsed-events.jsonl`

* `data/workspaces/conversations/conv-new-1779895225230/logs/claude-traces/2026-05-27T15-23-34-934Z-Claude_-trace-1779895414934-dudn91/thinking.txt`

事实：

* `metadata.json` 显示本次调用 `cwd` 是当前 conversation workspace，说明目录隔离生效。

* CLI 参数包含 `--permission-mode acceptEdits` 和 `--resume 39b1e991-8117-4c63-af53-7920ed3dd65f`。

* `parsed-events.jsonl` 的 init 事件显示工具列表包含 `WebFetch`、`WebSearch`、`Bash`、`Read`、`Write` 等完整 Claude Code 工具。

* 同一 trace 中没有真实 `tool_use` / `tool_call` / `permission_request` 事件。

* `thinking.txt` 显示模型引用了 CLI 内部工具权限说明，并推断“WebSearch 需要 permission approval，prompt 没显示可能是 UI 或 allowlist 问题”。

* 最终 `output.txt` 输出了“可以尝试在设置中将 `WebSearch` 添加到允许列表里 / allow WebSearch / /config”等底层 CLI 语义。

### 关键追踪 1：为什么早期 WebSearch 会这么回答

上一轮 `你试试` 的 trace 位于：

* `data/workspaces/conversations/conv-new-1779895225230/logs/claude-traces/2026-05-27T15-22-37-354Z-Claude_-trace-1779895357354-r58wyb/`

其中：

* `thinking.txt` 第 1 行：模型明确理解为“用户想让我试一次 web search”，并写出 “Let me search for something recent”。

* 同一个 `thinking.txt` 第 3 行：模型突然转为 “The user needs to grant permission for me to use WebSearch”。

* `parsed-events.jsonl` 只有 thinking 和 text 输出，没有任何 `content_block.type = "tool_use"`。

* `output.txt` 最终输出“联网搜索需要你授权才能执行”。

这说明执行顺序不是：

```text
尝试 WebSearch -> 被系统拦截 -> 产生权限请求 -> 告诉用户授权失败
```

而是：

```text
想尝试 WebSearch -> 看到/回忆 Claude Code 工具权限先验 -> 没有调用工具 -> 直接自然语言声称需要授权
```

后续用户说“我没看到”时，模型又把自己上一轮的错误说法当成事实继续推理，于是输出：

```text
看来权限请求还是没有成功传到你那边。这可能是工具权限模式的限制...
```

这不是系统状态，而是“错误前提 + 历史上下文自我强化”。

### 关键追踪 2：为什么最新 WebFetch 真的不能用

新增信息对应 trace：

* `data/workspaces/conversations/conv-new-1779895225230/logs/claude-traces/2026-05-27T15-34-21-932Z-Claude_-trace-1779896061932-z81v6r/`

这次和早期 WebSearch 不同，模型确实发起了多次 `WebFetch` tool\_use：

* 第一次调用参数错误：`{"/prompt":"https://www.baidu.com","prompt":"返回这个页面的主要内容摘要"}`，CLI 返回 `InputValidationError`，原因是缺少 `url` 且多了非法字段 `/prompt`。

* 第二次调用空对象：`{}`，CLI 返回 `InputValidationError`，原因是缺少 `url` 和 `prompt`。

* 第三次调用参数反了：`{"prompt":"https://www.baidu.com","url":"返回这个页面主要内容摘要"}`，CLI 返回 `Invalid URL`。

* 最后一次调用参数合法：`{"url":"https://www.baidu.com","prompt":"https://www.baidu.com"}`，CLI 返回真实权限错误：

```text
Claude requested permissions to use WebFetch, but you haven't granted it yet.
```

同一个 `result` 事件还包含：

```json
"permission_denials": [
  {
    "tool_name": "WebFetch",
    "tool_use_id": "call_e04eb16d9c5146e197986cc8",
    "tool_input": {
      "url": "https://www.baidu.com",
      "prompt": "https://www.baidu.com"
    }
  }
]
```

所以最新证据说明：

* `WebFetch` 工具不是“完全不可见”。

* `WebFetch` 工具能被模型发起。

* 前几次失败是模型生成了错误入参，不是权限。

* 合法入参后失败是 Claude CLI 权限拒绝，不是 KiKi 前端弹窗没显示。

这把根因从“纯模型幻觉”修正为：

```text
工具可见 -> 模型能发起 tool_use -> 入参多次错误 -> 合法入参触发 Claude CLI permission_denials -> 项目没有把 permission_denials 桥接成 KiKi 产品授权能力 -> 模型输出 Claude CLI 配置建议
```

### 为什么“暴露完整工具列表、权限说明”会有问题

这里的问题不是“工具多就会受限”，也不是“我们限制了 WebSearch”。问题是 Claude CLI 环境给模型提供了两类不属于 KiKi 产品语义的信息：

* 能力信息：`tools` 里有 `WebSearch`、`WebFetch`、`Bash`、`Write` 等。

* 权限先验：Claude Code 的系统语义中，工具可能处在需要用户确认、allowlist、permission mode、`/config` 等机制下。

在 Claude Code 原生终端里，这套语义可能成立；但在 KiKi 产品普通会话里：

* 用户看不到 Claude Code 原生授权 UI。

* 前端没有实现 `allow WebSearch` / `/config` 交互。

* 服务端没有收到真实 `permission_request`。

* 项目也没有限制 `WebSearch`。

所以模型把“Claude Code 内部权限机制”映射成“KiKi 产品里应该有授权弹窗”，这就是混淆。

核心不是“暴露完整工具列表导致 WebSearch 不能用”，而是“暴露 Claude Code 运行时语义后，模型开始站在 Claude Code 视角回答，而不是站在 KiKi 产品视角回答”。

### 为什么理论上产品没限制工具，但 Claude CLI 仍拒绝了 WebFetch

从代码看，项目层没有通过 `runPromptJson` 禁用普通会话工具：

* 普通会话走 `streamClaudeCli(...)`，不是 `runPromptJson(...)`。

* `runPromptJson(...)` 禁用 `WebSearch/WebFetch`，但不适用于这次普通会话。

* `metadata.json` 显示项目传入的 `permissionMode` 是 `execute`。

* `mapPermissionMode("execute")` 把它映射为 Claude CLI 参数 `--permission-mode acceptEdits`。

但关键误区在这里：`acceptEdits` 不是“允许所有工具”。从 trace 看，它至少没有自动允许 `WebFetch`。

当前 `buildAllowedTools(permissionMode)` 只有 `readonly` 时会返回：

```ts
["Read", "Glob", "Grep", "WebFetch", "WebSearch"]
```

而 `execute` 时返回空数组，导致普通会话启动 Claude CLI 时没有传 `--allowedTools WebFetch,WebSearch`。

所以虽然 KiKi 产品层没有写“禁用 WebFetch”，但 Claude CLI 层的实际行为是：

```text
WebFetch 在工具列表里可见，但不在当前 CLI permission allowlist 中，真实调用时被 permission_denials 拒绝。
```

因此修复重点不是让用户说 `allow WebFetch`，而是项目在普通会话启动 CLI 时主动传正确的 allowed tools，或者实现产品级授权桥接。

### 根因分层

#### 1. 目录隔离：已做，非主因

`src/app/api/claude/chat/route.ts` 已通过 `ensureConversationWorkspace(body.conversationId)` 创建会话 workspace，并把 `workspace.workspaceDir` 传给 `streamClaudeCli(...)`。事故 trace 的 `cwd` 也落在 `data/workspaces/conversations/conv-new-1779895225230`。

因此这次不是 Claude 读取了项目源码目录或其他会话 workspace 后产生混淆。

#### 2. Claude session 隔离：按会话复用，但仍承载 CLI 全局能力语义

普通会话使用 `conversation.claudeSessionId` 继续 `--resume` 同一个 Claude CLI session。这个做法保证了同一 KiKi 会话的上下文连续性，但也意味着 Claude CLI 的 init、工具列表、权限模式、slash commands、skills 等底层环境信息会持续存在于模型可见上下文中。

这不是跨用户会话串扰，但会让 KiKi 将自己理解为“Claude Code 代理”而不是纯粹的“KiKi 产品会话助手”。

#### 3. 工具授权配置：普通会话没有显式允许 WebFetch/WebSearch

`buildAllowedTools(permissionMode)` 当前只在 `readonly` 时收窄工具；`execute` 模式不传 `--allowedTools`，因此普通会话 init 暴露了完整 Claude Code 工具集。

最新 trace 证明：工具列表里出现 `WebFetch` 不代表调用时已授权。Claude CLI 先让模型看到工具 schema，也允许模型发出 `tool_use`，但在实际执行合法 `WebFetch` 时返回 `permission_denials`。

所以普通会话要么显式传 `--allowedTools WebFetch,WebSearch`，要么实现产品级授权 UI。当前两者都没有，所以 WebFetch/WebSearch 在 Claude CLI 层不可直接执行。

#### 4. 产品权限语义隔离：缺失，是直接主因

`buildWorkspaceBoundPrompt(...)` 只告诉模型“你是 KiKi，不是代码仓库开发助手”和“不得读取父目录”，没有明确说明：

* 不得向用户提及 Claude CLI、`WebSearch`、`WebFetch`、permission mode、allowlist、`/config` 等内部机制。

* 不得声称用户会看到授权弹窗，除非服务端真的发出了产品级 `permission_request` 事件。

* 如果需要联网，应实际调用工具；如果工具不可用或未调用，应如实说明“我还没有执行联网查询”。

* 工具调用成功/失败必须以真实工具事件为依据，不能基于模型内部推测。

因此模型把 CLI 的内部说明当成产品 UI 事实，产生了“授权弹窗”幻觉。

#### 5. 协议/UI 层：有类型但没有完整产品化流程

`src/lib/server/claude/transport.ts` 定义了 `permission_request` 事件类型，但当前 `consumeLine(...)` 没有把 `result.permission_denials` 解析成该事件。

`src/components/conversation/ConversationView.tsx` 收到 `permission_request` 时只是 `setStreamError(event.reason)`，也不是正式授权弹窗。

所以即使 Claude CLI 已经返回权限拒绝，前端也不会出现产品级授权提示；模型只能继续用自然语言解释，且容易泄露 Claude CLI 配置方式。

## Proposed Changes

### 1. 增强普通会话系统边界 Prompt

修改文件：`src/lib/server/claude/transport.ts`

修改位置：`buildWorkspaceBoundPrompt(...)`

新增一段“产品能力与内部工具边界”规则，建议内容：

```text
你通过 KiKi 产品能力服务用户，而不是直接向用户解释 Claude CLI 内部机制。
不得向用户提及或建议使用 Claude CLI、工具名、permission mode、allowlist、/config、allow WebSearch 等内部实现细节。
不得声称用户会看到授权弹窗，除非当前请求链路已经收到产品层 permission_request 事件。
如果用户询问联网能力：
- 只能说明“我可以在需要时尝试联网查询”，不要承诺已联网。
- 如果用户要求“试试联网/查一下/搜索一下”，必须实际发起可用的联网工具调用。
- 未发起工具调用、未收到工具错误、未收到产品层 permission_request 事件前，禁止回答“需要授权”“权限请求未成功”“请加入允许列表”等权限判断。
- 如果最终没有完成工具调用，只能说明“我没有实际完成联网查询”，不要推测原因。
- 如果工具调用失败，只能基于真实错误信息解释，不要猜测权限设置或 UI 弹窗。
```

目的：

* 切断模型从 CLI 内部权限说明到产品 UI 的错误推理。

* 保持 KiKi 身份稳定，避免输出 `allow WebSearch`、`/config` 等不属于 KiKi 产品的建议。

实现细节：

* 在 `buildWorkspaceBoundPrompt(...)` 的 `parts` 初始数组中加入规则。

* 保留现有 workspace 目录边界规则，不改变任务/规划链路。

* 文案应使用中文，因为当前 KiKi 产品主要面向中文用户。

### 2. 为普通会话显式允许只读与联网工具

修改文件：`src/lib/server/claude/transport.ts`

当前：

```ts
function buildAllowedTools(permissionMode: RuntimePermissionMode) {
  if (permissionMode !== "readonly") return [];
  return ["Read", "Glob", "Grep", "WebFetch", "WebSearch"];
}
```

建议改为显式区分普通会话和任务执行，并让普通会话无论 `permissionMode` 是 `readonly`、`confirm` 还是 `execute`，都传入只读与联网工具白名单：

```ts
type ClaudeToolProfile = "conversation" | "task" | "json";

function buildAllowedTools(input: {
  permissionMode: RuntimePermissionMode;
  toolProfile: ClaudeToolProfile;
}) {
  if (input.toolProfile === "conversation") {
    return ["Read", "Glob", "Grep", "WebFetch", "WebSearch"];
  }
  if (input.permissionMode !== "readonly") return [];
  return ["Read", "Glob", "Grep", "WebFetch", "WebSearch"];
}
```

推荐第一阶段普通会话只暴露以下工具：

* `Read`

* `Glob`

* `Grep`

* `WebFetch`

* `WebSearch`

不暴露：

* `Write`

* `Edit`

* `Bash`

* `Task`

* `TodoWrite`

* `ScheduleWakeup`

* `CronCreate`

* `CronDelete`

* 其他 Claude Code 开发/配置/多代理工具

原因：

* 普通聊天通常不应该直接修改文件或执行 Bash。

* 只读工具已足够支持“读取当前会话 workspace 文件”和“联网查询”。

* 显式传 `--allowedTools WebFetch,WebSearch` 可以解决 Claude CLI 层真实 `permission_denials`。

* 不暴露写入/执行类工具可以降低模型把自己当成 Claude Code 开发代理的概率。

兼容性：

* 任务执行、目标规划、JSON 调用不应复用该 profile。

* `runPromptJson(...)` 已有 `buildJsonToolArgs(...)`，继续保持 JSON 通道禁用 `WebSearch/WebFetch` 的硬约束。

* 任务执行若需要写文件、生成产物、联网，应继续走任务 runner 的执行链路，而不是普通聊天链路。

### 3. 解析并桥接 CLI permission\_denials

修改文件：`src/lib/server/claude/transport.ts`

扩展 `ClaudeCliPayload` 类型，增加 `permission_denials`：

```ts
permission_denials?: Array<{
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: unknown;
}>;
```

在 `payload.type === "result"` 时：

* 如果 `payload.permission_denials?.length` 非空，先 emit 产品级 `permission_request` 或 `error`，不要只依赖模型最终自然语言。

* 文案使用 KiKi 产品语义，例如“当前运行环境未允许联网工具，请在 KiKi 运行环境设置中开启联网工具后重试”，不要输出 `allow WebFetch`、`/allow WebFetch`、`~/.claude/settings.json`。

* trace 保留原始 `permission_denials`，方便调试。

目的：

* 让真实 CLI 权限拒绝进入产品协议，而不是由模型自行解释。

* 让前端能显示明确状态，而不是用户看不到任何弹窗。

* 避免 `allow WebFetch`、`/config` 等 Claude CLI 内部建议污染普通会话。

### 4. 将工具调用事件作为能力陈述的依据

修改文件：`src/lib/server/claude/transport.ts`

新增内部状态：

```ts
let toolCallCount = 0;
let webToolCallCount = 0;
```

在 `content_block_stop` 解析工具时：

* 如果工具名包含 `WebSearch` / `WebFetch`，增加 `webToolCallCount`。

* trace metadata 或 parsed events 中保留已有工具事件即可，不强制新建持久字段。

此变更本身不直接阻止模型输出，但可为后续前端/调试面板提供判定依据：

* KiKi 若声称已搜索，trace 应存在 `tool_call`。

* 若有 `permission_denials`，可快速确认是 CLI 授权问题，而不是参数错误或网络失败。

### 5. 补齐产品级 Permission Request 协议

修改文件：

* `src/lib/server/claude/transport.ts`

* `src/types/runtime.ts`

* `src/lib/api/claude.ts`

* `src/components/conversation/ConversationView.tsx`

第一阶段目标不是立刻做完整授权弹窗，而是把协议语义厘清：

* `permission_request` 表示“产品层确认请求”，不是模型自然语言猜测。

* 只有服务端从 CLI 原始事件或项目策略明确判断需要用户确认时，才能发送该事件。

* 前端收到后应显示产品定义的提示，而不是只 `setStreamError(...)`。

建议事件结构：

```ts
type ClaudePermissionRequestEvent = {
  type: "permission_request";
  reason: string;
  toolName?: string;
  requestId?: string;
  policy: "product_permission";
};
```

前端第一阶段可继续展示为错误/提示，但文案必须产品化：

```text
当前操作需要你授权 KiKi 使用联网查询。请在 KiKi 设置中开启联网能力后重试。
```

不要暴露：

* `allow WebSearch`

* `/config`

* Claude CLI allowlist

* permission mode

如果当前无法从 Claude CLI 稳定解析权限请求，则不要伪造弹窗；只修复模型不要声称有弹窗。

### 6. 增加会话上下文清理规则，避免错误回答自我强化

修改文件：`src/lib/server/workspace/contextPack.ts`

当前上下文包会把最近 12 条消息原样注入，包括 KiKi 已经说错的：

```text
联网搜索需要你授权才能执行。你当前看到的界面应该有一个权限确认的提示...
```

这会让后续同一会话继续沿用错误前提。

建议新增一个很窄的 sanitizer：

```ts
const INTERNAL_TOOL_LEAK_PATTERNS = [
  /allow WebSearch/gi,
  /\/config/g,
  /WebSearch\s*添加到允许列表/g,
  /权限确认的提示/g,
  /授权弹窗/g,
];
```

处理策略：

* 不删除用户真实消息。

* 对 KiKi 历史消息中的内部工具建议做最小替换，例如：

  * 原文：`你可以对系统说 "allow WebSearch" 或者使用 /config 命令`

  * 替换：`如需联网，请在 KiKi 产品设置中开启联网能力后重试。`

目的：

* 避免错误文案在 `contextPack` 中继续污染下一轮普通对话。

* 保持上下文可读，不需要清空会话历史。

风险：

* sanitizer 过宽会改写用户想讨论的技术内容。

* 第一阶段只匹配非常具体的错误短语，不做泛化替换。

### 7. Trace 面板增加诊断提示

修改文件：

* `src/components/dev/ClaudeTracePanel.tsx`

建议在 trace 详情中展示三个诊断字段：

* `工具列表包含 WebSearch`

* `本轮实际 Web 工具调用次数`

* `本轮是否出现 permission_request`

目的：

* 调试时能直接区分“工具可见”“工具被调用”“权限请求真实发生”三件事。

* 避免后续再次把模型自然语言当成真实权限状态。

此项为调试增强，优先级低于 prompt 和工具收窄。

## Assumptions & Decisions

* 当前问题不是 conversation workspace 目录隔离失败；目录隔离已生效。

* 当前问题也不是 `runPromptJson` 禁用 `WebSearch` 导致；普通聊天走 `streamPrompt` / `streamClaudeCli`。

* 第一优先级是让普通会话显式允许 `WebFetch/WebSearch`，消除 CLI 层真实 `permission_denials`。

* 第二优先级是阻止 KiKi 输出 Claude CLI 配置建议，例如 `allow WebFetch`、`/allow WebFetch`、`~/.claude/settings.json`。

* 普通会话应保留联网查询能力，但不应暴露写文件、Bash、Task 等 Claude Code 开发工具。

* 如果用户明确要求联网测试，KiKi 应实际调用 `WebSearch` / `WebFetch`；如果工具调用被 CLI 拒绝，服务端应将 `permission_denials` 转为产品级事件或错误，而不是让模型自行解释。

* 暂不实现完整授权弹窗，除非后续确认 Claude CLI 权限请求事件可稳定解析，或产品决定新增 KiKi 自有联网授权开关。

## Implementation Steps

1. 修改 `src/lib/server/claude/transport.ts` 的工具白名单逻辑，为普通会话显式传 `--allowedTools Read,Glob,Grep,WebFetch,WebSearch`，解决 `execute -> acceptEdits` 下 Web 工具真实 `permission_denials`。
2. 在 `ClaudeStreamOptions` 中新增可选 `toolProfile?: "conversation" | "task"`，默认保持现状；`src/app/api/claude/chat/route.ts` 调用普通会话时传 `toolProfile: "conversation"`。
3. 修改 `src/lib/server/claude/transport.ts` 的 `buildWorkspaceBoundPrompt(...)`，加入产品能力边界、禁止内部工具泄露规则，以及 WebFetch/WebSearch 参数使用提示。
4. 修改 `src/lib/server/claude/transport.ts`，解析 `result.permission_denials` 并转成产品级 `permission_request` 或 `error` 事件，文案不得包含 `allow WebFetch`、`/allow WebFetch`、`~/.claude/settings.json`。
5. 修改 `src/lib/server/workspace/contextPack.ts`，对 KiKi 历史消息中非常具体的错误内部工具建议做最小清理，避免错误回答在同一会话中自我强化。
6. 可选修改 `src/types/runtime.ts`、`src/lib/api/claude.ts`、`src/components/conversation/ConversationView.tsx`，把 `permission_request` 语义改成产品级事件；如果本轮不实现 UI 弹窗，则至少确保文案不再提 Claude CLI 内部机制。
7. 可选增强 `src/components/dev/ClaudeTracePanel.tsx`，展示 Web 工具实际调用与权限请求诊断信息。

## Verification Steps

### 静态验证

* 运行 `pnpm lint`。

* 运行 `pnpm build` 或至少 `pnpm tsc --noEmit`，如果项目没有 tsc script，则使用 `pnpm exec tsc --noEmit`。

* 使用 `GetDiagnostics` 检查修改过的 TypeScript 文件。

### 手动验证

1. 启动开发服务。
2. 新建普通 KiKi 会话，发送：`你现在能联网查询吗`。
3. 预期回答：

   * 可以说明“我可以尝试联网查询”。

   * 不应提 `WebSearch`、`allow WebSearch`、`/config`、Claude CLI、allowlist、permission mode。
4. 继续发送：`webfetch 获取 baidu.com`。
5. 预期行为：

   * trace 中出现真实 `WebFetch` tool\_use，合法入参应包含 `url: "https://www.baidu.com"` 和非 URL 的摘要 prompt。

   * 修复后不应再出现 `permission_denials`。

   * 如果底层仍拒绝工具，前端应收到产品级错误或授权事件，不应输出 `allow WebFetch`、`/allow WebFetch`、`~/.claude/settings.json`。
6. 打开 Claude Trace 面板检查：

   * `cwd` 仍是当前 conversation workspace。

   * init 工具列表不再包含写文件、Bash、Task 等普通聊天不需要的工具。

   * 没有真实 permission\_request 时，前端不显示授权弹窗，KiKi 也不声称有弹窗。

### 回归验证

* 普通会话“今天是几号”仍能基于系统上下文或会话上下文正常回答。

* 普通会话“继续/恢复”在没有规划状态时仍提示当前会话没有可恢复任务。

* 目标规划链路继续使用 `runPromptJson(...)`，仍默认禁用 `WebSearch/WebFetch`。

* 任务执行链路不受普通会话工具收窄影响，仍可按任务需要生成文件、调用工具、落盘产物。

## Rollout Notes

* 该修复可分两阶段上线。

* 阶段一：prompt 边界 + 普通会话工具白名单 + 上下文 sanitizer，快速阻止错误文案。

* 阶段二：产品级 permission\_request 协议和 Trace 面板诊断，完善长期可观测性。

* 若阶段一后发现普通会话确实需要写 workspace 文件，应不要直接恢复完整工具集，而是新增明确的产品动作入口，例如“保存为会话笔记”或“生成附件”，再由服务端受控写入。


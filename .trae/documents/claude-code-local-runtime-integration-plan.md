# 本地 Claude Code 接入计划

## Summary

目标：将当前纯前端 mock 的 `KiKi` 对话能力，升级为“网页 UI + 本机 Claude Code CLI” 的真实对话链路，并在“设置 -> 运行环境”中提供完整的本地运行环境接入引导。

本次方案覆盖：
- 右侧 `AssistantSidebar` 与 `/conversations` 全量接入本地 `claude` CLI
- 使用流式回复，前端逐字/逐段显示 Claude 输出
- 设置页支持“添加本地环境”向导、在线状态展示、连接检测
- 运行环境采用“全局当前环境”绑定策略
- 权限模式支持三档切换：只读聊天 / 手动确认 / 项目内可执行
- 工作目录采用“单项目目录”模式

明确不做：
- 先不接云端真实 Agent；现有 cloud env 继续保留为 UI 占位
- 先不做“每个会话独立环境”或“消息级切换环境”
- 先不做跨项目多目录工作区；`--add-dir` 暂不开放到 UI

## Current State Analysis

### 现有前端对话链路

- `src/stores/assistantStore.ts`
  - 当前仅维护本地消息数组与抽屉开关状态。
  - `send()` 直接同步写入用户消息 + mock KiKi 回复，没有网络请求、没有 loading、没有 streaming。
- `src/components/layout/AssistantSidebar.tsx`
  - 直接读取 `useAssistantStore()` 的 `messages` 与 `send()`。
  - 目前只适合本地 mock，不支持错误态、流式态、环境状态展示。
- `src/components/conversation/ConversationView.tsx`
  - `onSend()` 直接写入 user message，再用 `setTimeout` 注入 mock KiKi 文本。
  - 没有服务端 API、没有 session 映射、没有流式事件。
- `src/stores/conversationStore.ts`
  - 当前只负责前端消息列表增删改，不包含远程请求状态、运行环境、Claude session id。

### 现有设置与运行环境 UI

- `src/components/layout/UserMenu.tsx`
  - 已有“设置”弹窗，且“运行环境”是左右分栏布局，符合项目既有设计规范。
  - 当前本地/云端环境数据写死在组件内部状态 `INITIAL_RUNTIME_ENVS`。
  - “添加本地环境”只是录入名称、路径、CLI 命令的静态表单，不做检测、不持久化、不展示在线状态。

### 后端与基础设施现状

- `src/app` 下当前没有任何 `route.ts`，项目仍是纯前端原型。
- `src/lib/api/dora.ts` 仍是 mock 包装，未对接真实服务。
- `src/app/layout.tsx` + `src/components/layout/AppShell.tsx`
  - 已具备全局壳子，适合挂载全局运行环境状态与右侧 Assistant。
- 本机已确认存在可用 `claude` CLI：`/opt/homebrew/bin/claude`
- 本机 `claude --help` 已确认支持：
  - `-p/--print`
  - `--output-format stream-json`
  - `--include-partial-messages`
  - `--resume`
  - `--session-id`
  - `--permission-mode`
  - `--add-dir`

## Assumptions & Decisions

### 产品决策

- 接入范围：右侧 `KiKi` 助手 + `/conversations` 会话页全部接入本地 Claude。
- 回复方式：默认流式回复。
- 工作目录：每个本地环境绑定一个“单项目根目录”。
- 环境绑定：采用“全局当前环境”。
- 权限模式：设置页提供三档切换。
- 添加环境时必须做连接检测；运行环境页持续展示已连接环境状态。

### 技术决策

- 使用 Next.js App Router API Route 作为浏览器与本地 CLI 的桥接层。
- 服务端通过 Node runtime 启动本机 `claude` 子进程，禁止浏览器直接调用本地 CLI。
- 流式返回采用 `text/event-stream`（SSE）而不是 WebSocket：
  - 现有项目没有 socket 基础设施
  - 对“单次用户提问 -> 单条 Claude 回复流式渲染”的场景更简单
- 每次发送消息都启动一次 `claude -p --output-format stream-json` 进程。
- 会话上下文通过服务端保存的 `claudeSessionId` / `resumeSessionId` 续聊，不使用浏览器本地拼 prompt 伪造多轮上下文。
- 环境信息与默认环境配置先持久化在 `localStorage`；环境在线状态通过服务端实时检测返回。
- 只在服务端暴露当前项目目录下的工作能力，不开放任意系统目录浏览器侧执行。

### 权限模式映射

- `只读聊天`
  - `--permission-mode default`
  - 配合受限 `--allowedTools`，仅允许对话所需的最小工具集合
  - UI 上标记为“不会修改项目”
- `手动确认`
  - `--permission-mode default`
  - 保留 Claude 常规工具能力
  - 当 CLI 请求执行写操作/命令时，服务端先拦截并返回“待确认”事件给前端，用户确认后再继续
  - 这是默认模式
- `项目内可执行`
  - `--permission-mode acceptEdits` 或等价宽松模式
  - 允许当前工作目录内文件编辑与命令执行

注：若 CLI 的实际事件流里无法细粒度暂停权限确认，则降级为：
- “手动确认”模式下不自动继续高风险操作，而是中断该轮并将请求内容回显给用户确认后重发。

## Proposed Changes

### 1. 新增运行环境状态层

新增文件：
- `src/stores/runtimeEnvStore.ts`

职责：
- 管理本地/云端运行环境列表
- 管理当前激活环境 `activeRuntimeEnvId`
- 管理权限模式 `readonly | confirm | execute`
- 管理环境健康状态 `online | offline | checking | misconfigured`
- 提供持久化与 hydration

建议数据结构：

```ts
type RuntimePermissionMode = "readonly" | "confirm" | "execute";

type RuntimeHealth =
  | { status: "checking" }
  | { status: "online"; cliPath: string; claudeVersion?: string }
  | { status: "offline"; reason: string }
  | { status: "misconfigured"; reason: string };

type RuntimeEnvironment = {
  id: string;
  type: "cloud" | "local";
  name: string;
  workingDirectory: string;
  cliPath: string;
  permissionMode: RuntimePermissionMode;
  isDefault?: boolean;
  lastCheckedAt?: string;
  health?: RuntimeHealth;
};
```

原因：
- 运行环境已不适合继续放在 `UserMenu.tsx` 组件局部 state
- 后续 Assistant 与 Conversations 都要共享同一默认环境

### 2. 将设置页“运行环境”改为真实接入向导

修改文件：
- `src/components/layout/UserMenu.tsx`

拆分建议：
- `src/components/settings/SettingsModal.tsx`
- `src/components/settings/RuntimeEnvironmentPanel.tsx`
- `src/components/settings/LocalRuntimeWizard.tsx`
- `src/components/settings/RuntimeStatusBadge.tsx`

改动内容：
- 把当前内联的 `SettingsModal` 拆出独立组件，避免 `UserMenu.tsx` 继续膨胀
- “添加本地环境”改为分步引导：
  1. 输入环境名称
  2. 选择/输入工作目录
  3. 自动检测 `claude` CLI 是否存在
  4. 检测该目录是否可访问
  5. 检测 Claude 是否已登录且可执行一条测试 prompt
  6. 选择默认权限模式
  7. 保存并设为当前环境
- 运行环境列表卡片新增：
  - 当前环境标记
  - 在线/离线/检测中状态
  - 工作目录
  - CLI 路径
  - 权限模式
  - “重新检测”“设为当前环境”操作

原因：
- 用户明确要求“通过设置-运行环境来引导连接本地 Claude CLI”
- 用户还要求环境状态在设置页持续可见，而不是只保存静态配置

### 3. 新增服务端 CLI 桥接层

新增文件：
- `src/lib/server/claudeCli.ts`
- `src/lib/server/runtimeEnvValidation.ts`
- `src/lib/server/sse.ts`

职责：
- `claudeCli.ts`
  - 统一封装 spawn `claude`
  - 根据权限模式组装参数
  - 支持 `stream-json` 解析
  - 将 CLI 事件转换为前端可消费的 SSE 事件
- `runtimeEnvValidation.ts`
  - 校验工作目录存在性
  - 校验 `claude` 是否在 PATH / 自定义路径下可执行
  - 执行轻量健康检查（如最短 print prompt）
- `sse.ts`
  - 统一写入 `event:` / `data:` 包格式

CLI 调用策略：

```bash
claude -p \
  --output-format stream-json \
  --include-partial-messages \
  --permission-mode <mapped-mode> \
  [--resume <sessionId>] \
  [--add-dir <dir>] \
  "<prompt>"
```

原因：
- 需要把 Claude CLI 的本地能力包装为 Web UI 可消费的服务端协议
- 保证 Assistant 与 Conversation 共用同一条服务端链路

### 4. 新增 API Routes

新增文件：
- `src/app/api/runtime-envs/check/route.ts`
- `src/app/api/runtime-envs/status/route.ts`
- `src/app/api/claude/chat/route.ts`

接口设计：

#### `POST /api/runtime-envs/check`

用途：
- 添加/编辑本地环境时执行一次完整检测

输入：

```json
{
  "name": "My Mac",
  "workingDirectory": "/Users/bytedance/Documents/trae/long_horizon_agent",
  "cliPath": "claude",
  "permissionMode": "confirm"
}
```

输出：

```json
{
  "ok": true,
  "cliPath": "/opt/homebrew/bin/claude",
  "workingDirectoryExists": true,
  "authenticated": true,
  "version": "x.y.z"
}
```

#### `GET /api/runtime-envs/status?workingDirectory=...&cliPath=...`

用途：
- 设置页打开后刷新环境状态
- 支持“重新检测”

#### `POST /api/claude/chat`

用途：
- 发起 Claude 流式对话
- 供 AssistantSidebar 与 ConversationView 共用

输入：

```json
{
  "message": "帮我看看这个项目应该怎么接本地 Claude Code",
  "conversationId": "conv-123",
  "runtimeEnv": {
    "id": "env-local-1",
    "workingDirectory": "/Users/bytedance/Documents/trae/long_horizon_agent",
    "cliPath": "claude",
    "permissionMode": "confirm"
  },
  "claudeSessionId": "optional-session-id",
  "source": "assistant-sidebar"
}
```

输出：
- `Content-Type: text/event-stream`
- 事件定义：
  - `session`: 返回 Claude session id / resume id
  - `delta`: 增量文本
  - `message`: 完整 assistant message
  - `permission_request`: 需要用户确认的高风险动作
  - `status`: checking / running / completed
  - `error`: 错误信息
  - `done`: 本轮结束

原因：
- 当前项目没有任何 route，必须补齐真实服务端层
- 将环境检测与聊天流拆开，职责更清晰

### 5. 将右侧 KiKi 助手改成真实流式对话

修改文件：
- `src/stores/assistantStore.ts`
- `src/components/layout/AssistantSidebar.tsx`
- `src/components/layout/AssistantComposer.tsx`

改动内容：
- `assistantStore` 从纯本地 mock 改为：
  - 保存消息数组
  - 保存请求中状态 `isSending`
  - 保存当前错误 `error`
  - 保存当前使用的环境信息快照
  - 新增 `sendViaClaude()`，内部调用 `/api/claude/chat`
- UI 支持：
  - 发送后立即显示用户消息
  - 插入一条空的 assistant message 占位
  - 随 `delta` 实时更新内容
  - 显示“当前环境未连接/离线”提示
  - 显示权限确认提示条
  - 在页脚补一个简洁环境标签，如“本地 Claude · 手动确认”
- `AssistantComposer`：
  - 模型下拉先保留 UI，但当本地 Claude 模式启用时展示“Claude Code Local”
  - 可禁用与当前接入无关的模型选项，避免误导

原因：
- 右侧 Assistant 是全局入口，必须与运行环境状态强绑定

### 6. 将 `/conversations` 改成真实 Claude 会话

修改文件：
- `src/components/conversation/ConversationView.tsx`
- `src/stores/conversationStore.ts`
- `src/types/dora.ts`

新增/调整字段：
- `Conversation` 增加：
  - `runtimeEnvId?: string`
  - `claudeSessionId?: string`
  - `status?: "idle" | "streaming" | "error"`
- `ConversationMessage` 增加可选字段：
  - `status?: "streaming" | "done" | "error"`
  - `source?: "user" | "kiki" | "system"`

改动内容：
- `ConversationView.onSend()` 改为：
  - 先校验当前默认环境在线
  - 写入 user message
  - 创建 assistant 占位消息
  - 调用 `/api/claude/chat`
  - 流式更新最后一条 assistant message
  - 接收到 `session` 事件时保存 `claudeSessionId`
- 保留现有引用消息 UI，但引用内容先作为 prompt augmentation 注入
- 先不改变任务卡片等会话内其他消息模型；仅替换纯文本对话链路

原因：
- 用户要求“跟 AI 的对话，实际上都是和本地 Claude Code 的对话”
- `/conversations` 当前是主要对话中心，必须成为主链路

### 7. 补一层前端 API 封装

新增文件：
- `src/lib/api/runtime-envs.ts`
- `src/lib/api/claude.ts`

职责：
- 将 `fetch` / SSE 消费逻辑从组件中抽离
- 提供：
  - `checkRuntimeEnv()`
  - `getRuntimeEnvStatus()`
  - `streamClaudeChat()`

原因：
- 当前 `src/lib/api/dora.ts` 仍是 mock 风格，不适合承载 SSE 解析
- 可以让 Assistant 与 Conversation 共用一套客户端封装

### 8. 错误态与边界处理

需要覆盖的失败模式：
- `claude` CLI 不存在
- Claude 未登录/认证失效
- 工作目录不存在
- 工作目录无权限访问
- 用户发送消息时当前环境离线
- CLI 进程异常退出
- 流式中断
- 权限请求未被确认

前端呈现策略：
- 设置页卡片显示离线原因
- 会话区域保留错误消息气泡，不吞掉用户输入
- 发送按钮在 streaming 期间进入禁用态
- 若默认环境缺失，则 Assistant 与 Conversation 输入框顶部展示引导入口，点击直达“设置 -> 运行环境”

## Data Flow

### 添加本地环境

1. 用户打开 `UserMenu -> 设置 -> 运行环境`
2. 点击“添加本地环境”
3. 在 `LocalRuntimeWizard` 输入名称、工作目录、CLI 路径（默认 `claude`）
4. 前端调用 `POST /api/runtime-envs/check`
5. 服务端检测目录、CLI、认证状态
6. 前端显示检测结果
7. 用户确认保存
8. `runtimeEnvStore` 持久化该环境并设为当前环境

### 发送一条 Claude 消息

1. 用户在 `AssistantSidebar` 或 `ConversationView` 输入消息
2. 前端读取 `runtimeEnvStore.activeRuntimeEnvId`
3. 若环境离线，阻止发送并提示
4. 前端调用 `POST /api/claude/chat`
5. 服务端根据环境配置 spawn `claude`
6. 服务端解析 `stream-json`，转成 SSE 事件
7. 前端持续更新 assistant message
8. 收到 `session` 事件后记录 `claudeSessionId`
9. 收到 `done` 事件后将消息标记为完成

## Verification Steps

### 环境接入验证

- 在“设置 -> 运行环境”添加一个本地环境
- 输入当前仓库目录：`/Users/bytedance/Documents/trae/long_horizon_agent`
- 验证能够正确显示：
  - `claude` CLI 已找到
  - 工作目录存在
  - Claude 已登录
  - 环境状态为“在线”

### Assistant 验证

- 打开右侧 `KiKi` 助手
- 发送一条普通文本
- 验证用户消息立即出现
- 验证 Claude 回复按流式逐步出现
- 验证底部环境标签显示当前本地环境与权限模式

### Conversation 验证

- 新建一个会话并发送两轮连续消息
- 验证第二轮走的是同一个 `claudeSessionId` 上下文
- 刷新页面后验证会话消息仍保留在前端 store 持久化结果中

### 权限模式验证

- 在只读聊天模式下发送一个明显要求改代码的 prompt
- 验证不会直接执行写操作
- 切到手动确认模式后重复测试
- 验证前端出现待确认提示
- 切到项目内可执行模式后重复测试
- 验证 Claude 可以在当前项目目录执行真实工具操作

### 质量校验

- `pnpm lint`
- `pnpm build`
- 清理 `.next` 后固定在 `3000` 端口重启
- 手动验证：
  - `AssistantSidebar`
  - `/conversations`
  - 设置弹窗“运行环境”


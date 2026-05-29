# 普通会话工具权限：运行环境级管理选项设计方案

## 1. Summary

为运行环境（Runtime Environment）新增一项「会话工具权限」配置，统一控制所有普通会话（`/api/claude/chat`）调用 Claude CLI 时允许使用的工具。该配置：

* 落在 `RuntimeEnvironment` 上，作用域为「运行环境本身」，所有引用同一环境的会话都遵循该配置。
* 与现有 `permissionMode`（只读 / 手动确认 / 项目内可执行）解耦：`permissionMode` 控制 CLI 内部的边界（是否可写文件、是否需要 confirm），`toolPolicy` 控制「这个环境允许 KiKi 普通对话使用哪些 CLI 工具」。
* UI 上在「已连接环境」卡片里以胶囊组形式提供，遵循极简风格，不引入新 modal、不引入新背景色。
* 仅作用于普通会话（`streamPrompt`）。任务执行 / Plan JSON 调用走自己的工具策略（`runPromptJson` / 任务执行器），不在本次范围。

## 2. Current State Analysis

### 2.1 数据模型

[runtime.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/types/runtime.ts#L10-L21) 当前 `RuntimeEnvironment` 只有 `permissionMode`，没有任何工具能力字段。`RuntimeEnvironmentCheckInput` 同样没有。

### 2.2 客户端持久化

[runtimeEnvStore.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/stores/runtimeEnvStore.ts#L29-L135) 通过 `zustand/persist` 写入 `localStorage` key `kiki.runtime.environments`，包含 `environments` 和 `activeRuntimeEnvId`。改 schema 必须考虑历史本地缓存的兼容（旧记录无新字段）。

### 2.3 普通会话调用链

`POST /api/claude/chat` ([route.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/app/api/claude/chat/route.ts#L22-L77)) → `streamClaudeCli` → `streamPrompt` ([transport.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/claude/transport.ts#L471-L497))。

关键分支在 [transport.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/claude/transport.ts#L376-L379)：

```
function buildAllowedTools(permissionMode: RuntimePermissionMode) {
  if (permissionMode !== "readonly") return [];
  return ["Read", "Glob", "Grep", "WebFetch", "WebSearch"];
}
```

* `readonly` 显式 allowlist 含 `WebFetch/WebSearch`。
* `confirm` / `execute` 不传 `--allowedTools`，Claude CLI 默认对 `WebFetch/WebSearch` 走「需授权」拒绝路径，导致用户看到的「联网搜索需要授权弹窗」。
* CLI 参数里也没有 `--disallowedTools`。

### 2.4 设置 UI

[RuntimeEnvironmentPanel.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/settings/RuntimeEnvironmentPanel.tsx#L334-L360) 在每个 local 环境卡片里渲染「权限模式」胶囊组。新增的「会话工具权限」需要复用相同视觉规范（圆角胶囊 + 灰底 + 当前态加粗黑色描边）。

[LocalRuntimeWizard.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/settings/LocalRuntimeWizard.tsx#L425-L457) 引导流程的 `permission` step 里只问 `permissionMode`，不询问工具开关；本次为减少首次设置成本，新环境默认采用「推荐工具策略」，不在 wizard 里加新步骤。

### 2.5 任务执行 / JSON 通道（不在本次改动范围）

* `runPromptJson` 的 `JSON_DISALLOWED_TOOLS`（[transport.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/claude/transport.ts#L80-L101)）服务于结构化 JSON 调用，禁用 `WebFetch/WebSearch` 是为了防止规划/校验返回脏 JSON，不能被会话级开关覆盖。
* 任务执行器走 `streamPrompt`，但工作空间策略不同（`workspaceMode === "task"`），其工具权限默认沿用「项目内可执行」语义，本期不挂在会话开关上。

## 3. Proposed Changes

### 3.1 新增「会话工具权限」数据结构

文件：[runtime.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/types/runtime.ts)

新增类型：

```ts
// 一组独立开关；UI 上以胶囊组呈现
export type ChatToolCapability = "web" | "fileRead" | "shell";

// 会话工具权限。布尔表示该能力是否在普通会话中允许。
// 任务执行器、JSON 通道不受此结构控制。
export type ChatToolPolicy = {
  web: boolean;       // 控制 WebFetch + WebSearch
  fileRead: boolean;  // 控制 Read / Glob / Grep（在 conversation workspace 内）
  shell: boolean;     // 控制 Bash / RunCommand（仅当 permissionMode = execute 时生效）
};

export const DEFAULT_CHAT_TOOL_POLICY: ChatToolPolicy = {
  web: true,
  fileRead: true,
  shell: false,
};
```

修改 `RuntimeEnvironment`：增加 `chatToolPolicy?: ChatToolPolicy`（可选以兼容旧持久化数据），并把它加进 `RuntimeEnvironmentCheckInput`（保持可选）。

为什么（why）：

* 单一总开关粒度太粗，`permissionMode = execute` 不应被迫等于「能跑 shell」。
* 三类开关覆盖用户实际诉求：联网（WebFetch/WebSearch）、读文件（Read/Glob/Grep）、跑命令（Bash 类）。写文件类工具继续受 `permissionMode` 控制（这是 CLI 自身的边界，`toolPolicy` 不再叠加）。

### 3.2 服务端：将策略翻译成 CLI 参数

文件：[transport.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/claude/transport.ts)

* 扩展 `ClaudeStreamOptions`，新增 `chatToolPolicy?: ChatToolPolicy`。
* 改写 `buildAllowedTools(permissionMode, chatToolPolicy?)`：

  * `chatToolPolicy` 取 `policy ?? DEFAULT_CHAT_TOOL_POLICY`（注意：默认值集中维护在 `runtime.ts`，server 端从那里 import）。
  * 拼接 `allow` 集合：
    * `policy.web` → 加入 `WebFetch, WebSearch`
    * `policy.fileRead` → 加入 `Read, Glob, Grep`
    * `policy.shell && permissionMode === "execute"` → 加入 `Bash`
  * 原本 `permissionMode === "readonly"` 的硬编码 allowlist 改为：以 `policy` 计算结果为准，但当 `permissionMode === "readonly"` 时，强制把会写入的工具（`Write/Edit/MultiEdit/NotebookEdit/Task` 等）放进 `--disallowedTools`，避免用户错配。
  * 当 `allow` 集合为空时，仍然不加 `--allowedTools`（保持 CLI 默认行为）；同时构造 `--disallowedTools`，将 `policy` 中关闭的工具显式列出来，避免 CLI 走「需授权」分支。这里的关键是：CLI 里 `WebFetch/WebSearch` 默认会走授权请求，必须显式 disallow 才会真正拒绝并返回稳定错误，而不是停在「等用户授权」状态——这正是当前 KiKi 编出「请你点授权」的根因。
* `streamPrompt` 内：把 `options.chatToolPolicy` 传给 `buildAllowedTools` 与新增的 `buildDisallowedTools`，同时在 trace metadata 里写入 `chatToolPolicy`，便于排查。

文件：[claudeCli.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/claudeCli.ts)（确认位置后再具体）

* `streamClaudeCli` 增加 `chatToolPolicy` 透传参数。

文件：[claude/chat/route.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/app/api/claude/chat/route.ts#L50-L63)

* 把 `body.runtimeEnv.chatToolPolicy` 透传到 `streamClaudeCli`。
* 服务端做一次 `policy ?? DEFAULT_CHAT_TOOL_POLICY` 的 fallback，避免老客户端没传时行为漂移。

### 3.3 服务端校验：确保策略与权限模式一致

文件：[runtimeEnvValidation.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/runtimeEnvValidation.ts)

* `validateRuntimeEnvInput` 接受新字段。
* 校验规则：
  * `policy.shell === true` 且 `permissionMode !== "execute"` → 返回 `{ ok: false, reason: "shell 工具需要 permissionMode = 项目内可执行" }`。
  * 其他三类都允许任意组合。

### 3.4 客户端 store：迁移 + 写入

文件：[runtimeEnvStore.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/stores/runtimeEnvStore.ts)

* 新增 action `setChatToolPolicy(id, policy: Partial<ChatToolPolicy>)`，做浅合并。
* 在 `persist` 配置增加 `version` 与 `migrate`：
  * `version: 2`，旧数据没有 `chatToolPolicy` 时填 `DEFAULT_CHAT_TOOL_POLICY`。
* `INITIAL_ENVIRONMENTS`、cloud 默认环境 [defaultRuntimeEnvironments.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/runtime/defaultRuntimeEnvironments.ts) 增加默认 `chatToolPolicy`。

### 3.5 设置 UI：增加胶囊组

文件：[RuntimeEnvironmentPanel.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/settings/RuntimeEnvironmentPanel.tsx)

* 在「权限模式」胶囊下方新增一行「会话工具权限」，三类胶囊（联网 / 读取本地文件 / 终端命令），点击切换 `chatToolPolicy[key]`。
* `permissionMode !== "execute"` 时禁用「终端命令」胶囊并 hover 显示提示（hover-to-show metadata）。
* 复用已有视觉规范，不新增背景色、不新增分隔线，只通过描边/字色区分启用态。
* 在「权限模式」胶囊下方加一行 helper text（默认隐藏，hover 行级才出现），说明 `permissionMode` 与 `chatToolPolicy` 关系：「`permissionMode` 控制 CLI 内部边界（写入 / confirm）；`chatToolPolicy` 控制普通对话允许调用哪些工具。」

文件：[LocalRuntimeWizard.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/settings/LocalRuntimeWizard.tsx#L300-L320)

* `onSave` 时附带默认 `chatToolPolicy: DEFAULT_CHAT_TOOL_POLICY`。
* 不在引导流程里加新步骤；首次配置完成后用户去设置面板细调。

### 3.6 调用方：会话发起请求时附带 policy

涉及位置：

* [ConversationView.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/conversation/ConversationView.tsx) 中构造 `ClaudeChatRequest` 的位置。
* [AssistantSidebar.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/layout/AssistantSidebar.tsx) 同上（如果同样发起 chat 请求）。

改动：从 `useRuntimeEnvStore.getState().getActiveEnvironment()` 取的 environment 已包含 `chatToolPolicy`，所以这层不需要单独改请求体——只要保证 `runtimeEnv` 序列化时带上这个字段（默认行为）。需要做的是在请求构造前 fallback：`runtimeEnv.chatToolPolicy = runtimeEnv.chatToolPolicy ?? DEFAULT_CHAT_TOOL_POLICY`，避免 store 旧数据漏字段。

### 3.7 Trace 透出（用于排查）

文件：[traceStore.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/claude/traceStore.ts)（按需）

* `createClaudeTrace` 已经记录 `permissionMode`，本次扩展同时记录 `chatToolPolicy` 与最终落地的 `--allowedTools` / `--disallowedTools` argv。这样下次 KiKi 再「编」出「需要授权」时，trace 就能直接证伪。

### 3.8 Prompt 里告诉模型「能用什么」

文件：[transport.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/claude/transport.ts#L352-L374) 中的 `buildWorkspaceBoundPrompt`

* 在 prompt 末尾追加一段静态说明：
  ```
  当前会话允许的工具：{联动 chatToolPolicy 描述，例如 "WebFetch, WebSearch（联网） + Read/Glob/Grep（本地文件）"}。
  禁用的工具：{列举}。
  当某个工具被禁用时，请直接告诉用户「此环境已禁用 X 工具」，不要声称需要授权弹窗、不要建议用户去 ~/.claude/settings.json，不要建议输入 /allow 命令。
  ```
* 这一段是修复 KiKi 上一轮编造「allow WebFetch」的关键：服务端权限是真相，不允许模型再用 Claude Code 的内置叙事。

## 4. Assumptions & Decisions

| 项 | 决定 | 备注 |
| --- | --- | --- |
| 配置作用域 | 挂在 `RuntimeEnvironment` 上，跨会话 | 用户原话：「所有会话遵循这个选项」 |
| 粒度 | 三类开关：联网、读文件、终端 | 写文件继续由 `permissionMode` 控制；不在 chatToolPolicy 里 |
| 默认值 | `web: true, fileRead: true, shell: false` | 解决当前痛点：联网默认就该开 |
| 与 permissionMode 关系 | 解耦但有约束：shell 仅在 execute 下可开 | 防止 readonly 模式下声明能跑 bash |
| 任务执行 / JSON 通道 | 本期不受影响 | JSON 通道有自己的 `JSON_DISALLOWED_TOOLS`，独立维度 |
| 引导流程 | 不加新步骤，新环境用默认值 | 减少首次设置压力，符合极简偏好 |
| 持久化迁移 | `persist.version = 2`，旧数据补默认值 | 避免老用户打开后字段缺失导致行为漂移 |
| Wizard 文案修改 | 不动 | 暂不暴露细节，仅在主面板可调 |
| 后端校验 | 服务端再做一次合法性校验 | 防止客户端绕过 |

## 5. Verification Steps

1. **类型与构建**
   - `pnpm tsc --noEmit` 全量通过。
   - `pnpm lint` 无新增警告。

2. **服务端逻辑**
   - 新增单元粒度测试或脚本：给 `buildAllowedTools` / `buildDisallowedTools` 喂入 6 组组合（policy × permissionMode），断言 argv 形态正确。
   - 启动 dev 后检查 trace 文件 `args` 字段，包含期望的 `--allowedTools` / `--disallowedTools`。

3. **UI 行为**
   - 设置面板能切换「联网 / 读文件 / 终端」三胶囊，状态持久化（刷新页面后仍生效）。
   - 切到「只读聊天」时「终端命令」胶囊自动禁用并 hover 提示原因。
   - 旧 localStorage 数据（无 `chatToolPolicy`）打开后自动迁移为默认值，无 console error。

4. **端到端**
   - 关闭联网开关 → 普通对话里要求「webfetch baidu.com」 → KiKi 应直接回「此环境已禁用 WebFetch」，trace 中无 tool_use；CLI 不应再出现「permission_request 等待」。
   - 打开联网开关 → 同样请求 → trace 出现真实 `tool_use: WebFetch` 并返回内容。
   - 打开终端开关 + execute 模式 → 请求执行 `ls` → 真实 `Bash` tool_use；切到 confirm 模式后再问 → KiKi 回「当前权限模式不允许终端」。

5. **回归**
   - 任务执行链路（goalTaskRunner）执行一次现有 mock 任务，行为与改动前一致。
   - JSON 通道（goalPlanning）跑一次目标规划，结构化输出未受影响。

## 6. Out of Scope

* 任务执行器与 JSON 通道的工具策略细分（沿用现状）。
* 在引导流程里增加工具权限步骤。
* 可视化的 trace 工具调用面板增强（仅做最小数据落盘）。
* 对 cloud runtime 的工具策略（cloud 暂未接入真实服务，仅写入默认值）。

# Runtime File Policy：运行环境级工具权限完整方案 v2

## 1. Summary

为每个 `RuntimeEnvironment` 新增运行环境级 `filePolicy`，统一管理该 runtime 下 Claude CLI 可使用的工具范围。

本版更正 v1 的两个关键点：

* **作用范围更正**：`filePolicy` 对该 runtime 的全部 Claude 调用生效，不区分普通会话、目标规划、目标任务执行、后台 daemon 或恢复执行。所有调用先遵循 runtime 的 `filePolicy`，再由具体通道叠加更严格的策略。
* **UI 形态更正**：`filePolicy` 不是一组直接展开的布尔开关，而是三态模式：
  * `all_on`：全部工具能力开启。
  * `all_off`：全部工具能力关闭。
  * `custom`：自定义勾选具体能力。

核心原则：

* `filePolicy` 决定「这个 runtime 下哪些工具能力可用」。
* `permissionMode` 决定「工具可用后，执行时是否需要 Claude CLI 确认 / 是否自动接受编辑」。
* 具体业务通道可以在 `filePolicy` 基础上继续收窄，但不能放大。例如 JSON 规划通道仍然禁用写入、Bash、Web 等工具，即使 runtime 的 `filePolicy = all_on`。

## 2. Current State Analysis

### 2.1 Runtime 数据模型

[runtime.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/types/runtime.ts#L10-L21) 当前 `RuntimeEnvironment` 包含：

```ts
permissionMode: RuntimePermissionMode;
```

但没有 runtime 级工具权限字段。当前 UI 上的「权限模式」容易被误解为“全部工具权限”，实际上它只是映射 Claude CLI `--permission-mode`。

### 2.2 普通会话工具参数

[transport.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/claude/transport.ts#L376-L379) 当前：

```ts
function buildAllowedTools(permissionMode: RuntimePermissionMode) {
  if (permissionMode !== "readonly") return [];
  return ["Read", "Glob", "Grep", "WebFetch", "WebSearch"];
}
```

问题：

* `execute` 映射为 `acceptEdits`，但不传 `--allowedTools`，因此 `WebFetch/WebSearch` 真实调用时仍可能触发 Claude CLI `permission_denials`。
* 关闭某类工具时没有显式 `--disallowedTools`，模型仍能看到 Claude Code 内部权限叙事，容易输出 `allow WebFetch`、`/allow`、`~/.claude/settings.json` 等产品外文案。

### 2.3 JSON 通道已有独立硬限制

[transport.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/claude/transport.ts#L80-L101) 的 `JSON_DISALLOWED_TOOLS` 已固定禁用：

```ts
Write, Edit, MultiEdit, NotebookEdit, Bash, WebFetch, WebSearch, Task
```

这类通道的硬限制不能被 runtime `filePolicy` 放大。正确关系是：

```text
最终可用工具 = runtime filePolicy 允许集合 ∩ 当前调用通道允许集合
```

### 2.4 设置 UI 入口

[RuntimeEnvironmentPanel.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/settings/RuntimeEnvironmentPanel.tsx#L334-L360) 当前只有「权限模式」胶囊组，适合在其下方增加「文件与工具权限」三态控制。

[LocalRuntimeWizard.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/settings/LocalRuntimeWizard.tsx#L425-L457) 当前添加 runtime 时只选择 `permissionMode`。本方案默认不在 wizard 中增加额外步骤，避免首次配置变复杂；新增 runtime 使用默认 `filePolicy`。

### 2.5 Store 与持久化

[runtimeEnvStore.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/stores/runtimeEnvStore.ts#L29-L135) 当前持久化到 `kiki.runtime.environments`。新增字段必须兼容旧 localStorage 数据。

## 3. Concept Model

### 3.1 permissionMode 与 filePolicy 的边界

| 项 | `permissionMode` | `filePolicy` |
| --- | --- | --- |
| 回答的问题 | 工具执行时是否需要确认 | 哪些工具能力可以被使用 |
| CLI 参数 | `--permission-mode default/acceptEdits` | `--allowedTools` / `--disallowedTools` |
| 作用层级 | Claude CLI 执行确认机制 | KiKi 产品层 runtime 能力边界 |
| 能否关闭 WebFetch | 不能可靠关闭，也不能可靠放行 | 可以，通过 allowed/disallowed 显式控制 |
| 能否控制写入自动确认 | 可以 | 不负责确认行为，只负责工具是否出现 |
| 典型配置 | `readonly` / `confirm` / `execute` | `all_on` / `all_off` / `custom` |

硬规则：

* `filePolicy` 决定工具是否可用。
* `permissionMode` 决定可用工具执行时的确认行为。
* 任何调用通道都不得绕过 runtime `filePolicy` 放大工具权限。
* 业务通道可以继续收窄 runtime `filePolicy`，例如 JSON 通道强制无写入、无联网、无 Bash。

### 3.2 filePolicy 三态

```ts
export type RuntimeFilePolicyMode = "all_on" | "all_off" | "custom";
```

含义：

* `all_on`：启用所有 runtime 支持的工具能力。仍受 `permissionMode` 和通道级限制约束。
* `all_off`：关闭所有可选工具能力，仅保留 KiKi 运行所需的安全内部工具。
* `custom`：用户手动勾选具体能力。

### 3.3 自定义能力分组

运行环境级能力不直接暴露 22 个 Claude CLI 工具，而按用户可理解的能力聚合：

| Capability | 工具 | 默认 | 说明 |
| --- | --- | --- | --- |
| `web` | `WebFetch`, `WebSearch` | on | 联网搜索与网页抓取 |
| `fileRead` | `Read`, `Glob`, `Grep` | on | 读取当前调用 workspace 内文件 |
| `fileWrite` | `Write`, `Edit`, `NotebookEdit` | off | 写入当前调用 workspace 内文件 |
| `shell` | `Bash` | off | 执行终端命令 |
| `subagent` | `Task`, `TaskOutput`, `TaskStop`, `Skill` | off | 子代理与 skill 调用 |
| `schedule` | `CronCreate`, `CronDelete`, `CronList`, `ScheduleWakeup` | off | 定时任务与唤醒 |
| `planMode` | `EnterPlanMode`, `ExitPlanMode`, `EnterWorktree`, `ExitWorktree` | off | Claude CLI 内置 plan/worktree 能力 |

安全内部工具：

| 工具 | 处理 | 原因 |
| --- | --- | --- |
| `AskUserQuestion` | 始终允许 | 产品交互通道，不直接读写文件 |
| `TodoWrite` | 默认允许，可后续评估是否纳入自定义 | 主要用于状态表达，不直接读写文件 |

未归类的新工具：

* 默认进入 `--disallowedTools`。
* trace 中保留，后续再明确纳入某个 capability。

## 4. Data Design

文件：[runtime.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/types/runtime.ts)

新增类型：

```ts
export type RuntimeToolCapability =
  | "web"
  | "fileRead"
  | "fileWrite"
  | "shell"
  | "subagent"
  | "schedule"
  | "planMode";

export type RuntimeFilePolicyMode = "all_on" | "all_off" | "custom";

export type RuntimeFilePolicy = {
  mode: RuntimeFilePolicyMode;
  custom: Record<RuntimeToolCapability, boolean>;
};

export const DEFAULT_RUNTIME_FILE_POLICY: RuntimeFilePolicy = {
  mode: "custom",
  custom: {
    web: true,
    fileRead: true,
    fileWrite: false,
    shell: false,
    subagent: false,
    schedule: false,
    planMode: false,
  },
};
```

修改：

```ts
export type RuntimeEnvironment = {
  ...
  permissionMode: RuntimePermissionMode;
  filePolicy?: RuntimeFilePolicy;
};
```

`RuntimeEnvironmentCheckInput` 也增加 `filePolicy?: RuntimeFilePolicy`，用于服务端校验。

为什么 `filePolicy` 可选：

* 兼容旧 localStorage。
* 服务端和 store 都会通过 `normalizeRuntimeFilePolicy(...)` 补默认值。

## 5. Policy Resolution

新增工具策略解析模块：

文件建议：`src/lib/runtime/toolPolicy.ts`

职责：

* 定义 `TOOL_CAPABILITY_MAP`。
* 定义 `RUNTIME_MANAGED_TOOLS`。
* 提供 `normalizeRuntimeFilePolicy(policy?)`。
* 提供 `resolveRuntimeToolPolicy(filePolicy, permissionMode, channelPolicy)`。

核心算法：

```ts
type ToolChannelPolicy = {
  allow?: string[];
  disallow?: string[];
  mode?: "inherit" | "readonly_json" | "task" | "conversation";
};

type ResolvedToolPolicy = {
  allowedTools: string[];
  disallowedTools: string[];
  enabledCapabilities: RuntimeToolCapability[];
  disabledCapabilities: RuntimeToolCapability[];
};
```

解析规则：

1. 先把 runtime `filePolicy` 解析为 capability 布尔表：
   * `all_on`：全部 capability = true。
   * `all_off`：全部 capability = false。
   * `custom`：使用 `custom`，缺失字段补默认 false。
2. 根据 capability 映射得到 runtime 允许工具集合。
3. 加入安全内部工具：`AskUserQuestion`, `TodoWrite`。
4. 应用 `permissionMode` 硬约束：
   * `permissionMode === "readonly"` 时，`fileWrite` 和 `shell` 即使打开也不进入 allowed。
   * `permissionMode !== "execute"` 时，`shell` 不进入 allowed。
5. 应用通道级策略：
   * 普通会话：默认 `inherit`，使用 runtime 解析结果。
   * 目标任务执行：默认 `inherit`，使用 runtime 解析结果。
   * JSON 规划/校验：在 runtime 解析结果上强制 disallow `Write/Edit/MultiEdit/NotebookEdit/Bash/WebFetch/WebSearch/Task`。
6. 最终 `disallowedTools` = 所有受管理工具 - `allowedTools` + 通道强制禁用工具 + 未归类工具。

关键要求：

* 不允许只靠 Claude CLI 默认行为。
* 对关闭的工具必须显式 `--disallowedTools`。
* 对开启的 Web 工具必须显式 `--allowedTools WebFetch,WebSearch`，避免 Web 工具走 CLI 默认授权请求。

## 6. Server Integration

### 6.1 transport.ts

文件：[transport.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/claude/transport.ts)

改动：

* `ClaudeStreamOptions` 新增：

```ts
filePolicy?: RuntimeFilePolicy;
channelPolicy?: ToolChannelPolicy;
```

* 删除或替换现有 `buildAllowedTools(permissionMode)`。
* 在 `streamPrompt(...)`、`runPromptJson(...)`、`runPromptText(...)` 中统一调用 `resolveRuntimeToolPolicy(...)`。
* CLI args 改为始终按解析结果追加：

```ts
if (allowedTools.length > 0) args.push("--allowedTools", allowedTools.join(","));
if (disallowedTools.length > 0) args.push("--disallowedTools", disallowedTools.join(","));
```

注意：

* `runPromptJson(...)` 现在已有 `buildJsonToolArgs(...)`，需要改造成「runtime policy ∩ JSON channel policy」，不能直接用 JSON hardcoded list 覆盖 runtime policy。
* `buildTextToolArgs(...)` 同理统一走解析器。

### 6.2 claude/chat/route.ts

文件：[route.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/app/api/claude/chat/route.ts)

改动：

* 传入 `body.runtimeEnv.filePolicy`。
* `channelPolicy` 设为 `{ mode: "conversation" }`。
* 服务端 fallback：旧客户端缺字段时用 `DEFAULT_RUNTIME_FILE_POLICY`。

### 6.3 目标规划与任务执行

涉及文件：

* [goalPlanning.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts)
* [goalTaskRunner.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskRunner.ts)
* [taskFeedbackJudge.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/taskFeedbackJudge.ts)
* 其他调用 `runPromptJson` / `runPromptText` / `streamPrompt` 的服务端文件。

改动原则：

* 所有调用都传入 runtime 的 `filePolicy`。
* JSON 型调用继续传 `channelPolicy = readonly_json`，确保结构化输出稳定。
* 任务执行传 `channelPolicy = task`，最终能力仍受 runtime `filePolicy` 限制。

### 6.4 runtimeEnvValidation.ts

文件：[runtimeEnvValidation.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/runtimeEnvValidation.ts)

校验：

* `filePolicy.mode` 必须是 `all_on | all_off | custom`。
* `custom` 必须只包含合法 capability；缺字段补默认 false。
* 如果 `filePolicy` 开启 `shell` 且 `permissionMode !== "execute"`，不阻止保存，但 UI 和解析器会让其不生效；服务端返回 warning 更合适，避免用户切换 permissionMode 后丢配置。
* `all_on` 不等于绕过通道限制，JSON 通道仍强制只读。

## 7. Client Integration

### 7.1 runtimeEnvStore.ts

文件：[runtimeEnvStore.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/stores/runtimeEnvStore.ts)

新增 action：

```ts
setFilePolicyMode(id: string, mode: RuntimeFilePolicyMode): void;
setFilePolicyCustomCapability(id: string, capability: RuntimeToolCapability, enabled: boolean): void;
setFilePolicy(id: string, policy: RuntimeFilePolicy): void;
```

迁移：

* `persist.version = 2`。
* migrate 旧数据时给每个 environment 补 `DEFAULT_RUNTIME_FILE_POLICY`。
* `updateEnvironment` 时如果传入 `filePolicy`，先 normalize。

### 7.2 RuntimeEnvironmentPanel.tsx

文件：[RuntimeEnvironmentPanel.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/settings/RuntimeEnvironmentPanel.tsx)

UI 结构：

```text
执行权限模式                         [只读聊天] [手动确认] [项目内可执行]
控制工具执行时是否需要 Claude CLI 确认，不决定工具是否出现在可用列表中。

工具权限策略                         [全部开启] [全部关闭] [自定义勾选]
控制这个 Runtime 允许哪些工具能力。全部会话、目标模式、任务执行都会先遵循这里的设置。写入文件和终端命令还会受到「执行权限模式」约束；例如只读聊天下即使勾选，也不会真正生效。

自定义勾选时：
[✓] 联网  允许 KiKi 搜索互联网和读取网页内容。 WebFetch WebSearch
[✓] 读取文件  允许读取当前调用 workspace 内的文件和目录。 Read Glob Grep
[ ] 写入文件  允许在当前调用 workspace 内创建或修改文件。 Write Edit NotebookEdit
[ ] 终端命令  允许在当前调用 workspace 内执行终端命令。 Bash
[ ] 子代理  允许派发子代理或调用已安装 skill 处理复杂任务。 Task TaskOutput TaskStop Skill
[ ] 定时任务  允许创建、删除或查看定时唤醒任务。 CronCreate CronDelete CronList ScheduleWakeup
[ ] Plan Mode  允许使用 Claude CLI 内置 plan/worktree 能力。 EnterPlanMode ExitPlanMode EnterWorktree ExitWorktree
```

交互：

* 选择 `all_on`：隐藏自定义勾选行，内部解析为全部 capability true。
* 选择 `all_off`：隐藏自定义勾选行，内部解析为全部 capability false。
* 选择 `custom`：显示紧凑的 capability 勾选列表。
* 每个 capability 使用 checkbox 交互，不再使用点选胶囊；选中状态只由左侧勾选框表达，不显示“已勾选/未勾选”文字。
* 每个 capability 单行展示「名称 + 说明 + CLI 工具标签」，CLI 工具标签紧跟在说明文案后面，超出容器时自然折行。
* `permissionMode !== "execute"` 时，「终端命令」在解析结果中不生效，但保留用户原配置值；文案提示“需要执行权限模式 = 项目内可执行”。
* `permissionMode === "readonly"` 时，「写入文件」「终端命令」在解析结果中不生效；文案提示“只读聊天下不会生效”。

视觉约束：

* 模块标题固定为「工具权限策略」；上方 `permissionMode` 模块标题固定为「执行权限模式」。
* 三态按钮 `[全部开启] [全部关闭] [自定义勾选]` 与上方执行权限模式按钮一致，右侧固定并排展示，不换成上下两排。
* 说明文案区域给右侧按钮预留空间，左侧文案按容器宽度自动折行。
* 自定义列表使用紧凑行样式：小内边距、窄间距、小号工具标签，避免占用过高纵向空间。
* 不显示底部「最终允许能力 / 最终禁用能力」汇总区域，仅保留勾选列表本身。
* 不新增卡片背景色、不新增分割线、不加阴影；保持当前设置页的极简视觉。

已确认的独立 HTML 原型：

* `/tmp/kiki_toolpolicy_settings_preview.html`
* `http://127.0.0.1:8765/kiki_toolpolicy_settings_preview.html`

### 7.3 LocalRuntimeWizard.tsx

文件：[LocalRuntimeWizard.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/settings/LocalRuntimeWizard.tsx)

改动：

* `onSave(...)` 附带 `filePolicy: DEFAULT_RUNTIME_FILE_POLICY`。
* 不新增 wizard 步骤。
* ConfirmStep 中可增加一行只读展示：`File Policy：自定义（联网、读取文件已开启）`，但不提供编辑入口。

## 8. Prompt 与错误文案

文件：[transport.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/claude/transport.ts)

在 `buildWorkspaceBoundPrompt(...)` 中追加 runtime policy 摘要：

```text
当前 Runtime File Policy：
- 已允许：联网、读取文件
- 已禁用：写入文件、终端命令、子代理、定时任务、Plan Mode
当工具被禁用时，请直接说明“当前运行环境已禁用 xxx”，不要建议用户输入 /allow，不要建议修改 ~/.claude/settings.json，不要声称会出现授权弹窗。
```

如果 CLI 返回 `permission_denials`：

* 服务端解析 `result.permission_denials`。
* 转为产品级 `permission_request` 或 `error` 事件。
* 文案只提 KiKi 设置里的 `File Policy`，不提 Claude CLI 内部配置。

## 9. Assumptions & Decisions

| 项 | 决定 |
| --- | --- |
| 配置名称 | `filePolicy` |
| 作用范围 | 该 runtime 下全部 Claude 调用 |
| 三态 | `all_on` / `all_off` / `custom` |
| 默认值 | `custom`，仅 `web` 和 `fileRead` 开启 |
| 与 permissionMode 关系 | 正交，但解析时受其硬约束 |
| JSON 通道 | 先遵循 runtime `filePolicy`，再叠加 JSON 更严格限制 |
| 任务执行 | 遵循 runtime `filePolicy` |
| 未归类工具 | 默认禁用 |
| UI | Runtime 设置面板增加三态胶囊，自定义时显示能力勾选 |
| Wizard | 不增加新步骤，仅保存默认值 |

## 10. Full Review After Change

### 10.1 v1 需要更正的点

* v1 写成「仅作用于普通会话」是错误的；应为 runtime 全局生效。
* v1 的 `chatToolPolicy` 命名过窄；应改为 `filePolicy` 或 `runtimeFilePolicy`。
* v1 将 JSON 通道排除在外不准确；正确表达是：JSON 通道也先受 runtime `filePolicy` 约束，但会叠加更严格的通道级禁用。
* v1 的 UI 直接显示 capability 胶囊不符合用户要求；必须先有三态：全部开启 / 全部关闭 / 自定义勾选。
* v1 没有明确「all_on 不等于绕过 permissionMode 和通道限制」，需要补充。

### 10.2 新方案风险

* `all_on` 可能让用户误以为 JSON 规划也能联网或写文件；UI 文案必须说明“部分通道仍会因为稳定性自动收窄”。
* 如果 `permissionMode = readonly` 且 `filePolicy = all_on`，写入和 Bash 实际不会生效；UI 需要以 hover 文案解释。
* 统一接入所有调用点需要全面搜索 `runPromptJson`、`runPromptText`、`streamPrompt`，否则可能出现某些链路未遵循 runtime policy。
* Claude CLI 的 `--allowedTools` 与 `--disallowedTools` 参数组合需要实测，避免 variadic 参数吞 prompt 的问题复发；现有代码通过 stdin 传 prompt 是正确方向。

### 10.3 验收标准

* 设置面板能保存 `all_on/all_off/custom`。
* 刷新页面后 runtime 的 `filePolicy` 保持一致。
* 普通会话、目标任务执行都能在 trace args 中看到由同一 runtime `filePolicy` 解析出的 allowed/disallowed 工具。
* `filePolicy = all_off` 时，普通会话让 KiKi webfetch 或读文件，应直接得到产品级“运行环境已禁用”说明，而不是 Claude CLI 授权建议。
* `filePolicy = all_on` 且 `permissionMode = execute` 时，普通会话 WebFetch 不再出现 `permission_denials`。
* `runPromptJson` 即使 runtime `filePolicy = all_on`，仍不允许 Write/Bash/WebFetch/WebSearch。

## 11. Verification Steps

1. 运行 `pnpm tsc --noEmit`。
2. 运行 `pnpm lint`。
3. 手动迁移旧 localStorage，确认无 `filePolicy` 的 runtime 自动补默认值。
4. UI 验证三态切换：
   * `all_on` 隐藏自定义勾选。
   * `all_off` 隐藏自定义勾选。
   * `custom` 显示 capability 勾选。
5. 普通会话验证：
   * `all_off`：要求联网，KiKi 不调用 WebFetch，直接说明 runtime 禁用。
   * `all_on`：要求联网，trace 出现 WebFetch tool_use。
6. 目标任务验证：
   * 任务生成产物时遵循同一 runtime `filePolicy`。
   * 如果 `fileWrite = false`，任务不应写文件，应该返回产品级权限说明。
7. JSON 规划验证：
   * 即使 `all_on`，`runPromptJson` trace 中仍有 JSON 通道强制禁用工具。

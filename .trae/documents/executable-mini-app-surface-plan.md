# 可执行小应用区落地规划

## v1.2 Final Review Update

本次复查结论：

- 用户和生成 HTML 小应用的交互数据会被保存下来，并且后续可以持续查询。
- 当前方案可实施，但执行时必须补齐几个代码层防坑点，避免“小应用能显示但数据无法可靠进入后续任务”。

### 1. 交互数据保存与后续查询的确定性

第一版以服务端 `artifact_interaction_state` 为可信状态源，而不是 iframe 自己的 `localStorage`。

数据闭环必须满足：

```txt
用户操作 iframe 小应用
  -> 小应用调用 window.KikiBridge.patchState/saveState
  -> iframe postMessage 给宿主组件
  -> 宿主组件校验 source/artifactId/bridgeVersion/payload
  -> 宿主组件 POST /api/artifacts/[id]/state
  -> 服务端写入 artifact_interaction_state.state_json
  -> 后续任务构造 prompt 时查询并注入摘要
```

因此，后续任务可以持续读取：

- 当前完整状态：`state_json`
- 最近交互轨迹：`events_json`，只保留最近 50 条
- 归属信息：`conversation_id`、`task_id`、`instance_id`

### 2. 必须同步修改 parseAndRepair 白名单

当前 `src/lib/taskResult/parseAndRepair.ts` 的 `ALLOWED_ARTIFACT_KINDS` 仍只有：

```ts
["text_block", "file", "external_link"]
```

实施时必须加入：

```ts
"webapp"
```

否则 Runner 即使生成并挂载了 `webapp` artifactRef，也可能在 normalize 阶段被静默丢弃，导致前端找不到可执行小应用。

### 3. localValidation 必须识别 webapp 交互区

当前 `src/lib/taskResult/localValidation.ts` 仍用 `blocks.length > 0` 判断是否存在 interactive surface。

实施后判断规则必须改为：

```txt
interactiveSurfaceKind = blocks
  -> blocks.length > 0

interactiveSurfaceKind = webapp
  -> 存在 webapp artifactRef 或原始输出中存在可解析 webapp.html
```

否则纯 webapp 结果会被误判为 `missing_interactive_surface`。

### 4. prompt 里的 interactive 要求需要分流

当前 `src/lib/server/goalTaskPrompt.ts` 仍写着：

```txt
如果结果呈现区域包含 interactive，必须返回可页面渲染的 task_result.blocks
```

实施后应改成：

```txt
如果 interactiveSurface.kind = blocks，必须返回 task_result.blocks。
如果 interactiveSurface.kind = webapp，必须返回 webapp.html，并可返回 blocks 作为降级摘要。
```

这样可以避免模型同时被要求“生成 webapp”和“必须用 blocks 承载主交互区”。

### 5. preview API 与普通 artifact GET 必须分流

`src/app/api/artifacts/[id]/route.ts` 目前会把非 text/link artifact 当普通文件流式返回。

实施后：

- `/api/artifacts/[id]/preview` 专门返回 iframe 可运行 HTML，并设置严格 CSP。
- `/api/artifacts/[id]` 对 `webapp` 可返回下载版 HTML 或跳转到 preview，但不能无意中以普通 file 逻辑返回错误 mime/size。
- `ArtifactRef.previewUrl` 对 `webapp` 必须指向 `/api/artifacts/[id]/preview`。

### 6. bridge bootstrap 注入必须做安全转义

保存 HTML 前注入 bootstrap 时，`artifactId`、initial state 等动态值必须通过 `JSON.stringify` 写入脚本，不允许字符串拼接裸插值。

注入位置：

- 优先插入到 `</body>` 前。
- 如果没有 `</body>`，追加到文档末尾。

bootstrap 不应暴露任意执行能力，只提供：

```js
ready()
saveState(state, event)
patchState(patch, event)
reportHeight(height)
```

### 7. state patch 语义第一版采用浅合并

为避免深层 merge 规则不清晰，第一版定义：

- `state.replace`：整体替换 `state_json`。
- `state.patch`：只做顶层浅合并。
- 如果小应用需要更新嵌套对象，应发送完整嵌套字段。

### 8. 后续任务注入必须做限量摘要

后续任务不直接注入完整无限事件日志。

注入内容限制：

- 最近更新的 webapp state 优先。
- 每个 state 只注入关键字段摘要。
- recent events 只注入事件类型与少量 payload 摘要。
- 总长度设置上限，超过后截断并说明“已截断”。

这样可以避免 prompt 膨胀和无关状态污染当前任务。

## v1.1 Review Update

针对两个关键问题，本版做出明确修正：

### 1. 用户和 HTML 小应用的交互数据会被保存，并可持续查询

是。该能力是本方案的核心闭环，不是附带能力。

保存路径：

```txt
iframe HTML 小应用
  -> postMessage(state.patch / state.replace / event.emit)
  -> 宿主 SandboxedWebAppSurface 校验消息
  -> POST /api/artifacts/[id]/state
  -> artifact_interaction_state 表
  -> 后续任务 prompt 查询并注入
```

查询路径：

```txt
GET /api/artifacts/[id]/state
  -> 返回当前 state_json
  -> 返回 recent events
```

服务端查询路径：

```txt
goalTaskPrompt / interactionContext
  -> getArtifactInteractionState(artifactId)
  -> 注入后续任务上下文
```

因此，用户在 HTML 小应用中填写、选择、拖拽、勾选、计算出来的数据，都可以变成 KiKi 后续任务可读取的上下文。

### 2. 复查后需要修正的设计问题

#### 问题 A：sandbox iframe 不应依赖 event.origin 校验

如果 iframe 不加 `allow-same-origin`，浏览器会把 iframe 变成 opaque origin，`postMessage` 事件里的 `event.origin` 通常是 `"null"`。

因此不能用 `event.origin === location.origin` 做可信校验。

修正方案：

- 宿主保存 `iframeRef.current.contentWindow`。
- 只接受 `event.source === iframeRef.current.contentWindow` 的消息。
- 消息体必须包含 `source: "kiki-webapp"`、`artifactId`、`bridgeVersion`。
- `artifactId` 必须等于当前渲染的 artifact id。
- payload 必须通过 zod-like 手写校验或类型守卫。

#### 问题 B：状态保存不能只按 artifactId，还要保留归属信息

仅用 `artifact_id` 作为主键可以定位一个小应用，但后续任务检索时还需要知道它属于哪个会话、任务、实例。

修正方案：

`artifact_interaction_state` 表必须包含：

- `artifact_id`
- `conversation_id`
- `task_id`
- `instance_id`
- `state_json`
- `events_json`
- `created_at`
- `updated_at`

查询后续任务上下文时，按优先级检索：

1. 当前 task/instance 直接关联的 webapp artifact。
2. 同一 conversation 最近更新的 webapp state。
3. 同一 goal 下相关 task 的 webapp state。

MVP 先做前两项，第三项等 goal-level artifact index 再做。

#### 问题 C：事件日志不能无限增长

如果把所有交互事件都写入 `events_json`，长期使用会导致 SQLite 行越来越大。

修正方案：

- `state_json` 保存当前完整状态。
- `events_json` 只保留最近 50 条事件。
- 每条 event 最大 16KB。
- `state_json` 最大 100KB。
- 超限返回 413，并在 UI 显示“保存失败，数据过大”。

#### 问题 D：后续任务不能盲目注入所有 state

如果把所有小应用状态都塞进 prompt，会造成 token 膨胀和上下文污染。

修正方案：

- 后续任务 prompt 只注入与当前 conversation 相关、最近更新、且 summary 相关的小应用 state。
- 注入前做压缩：
  - artifact label
  - updatedAt
  - state_json 的关键字段
  - recentEvents 的事件类型摘要
- 原始完整 state 保留在数据库，可按需查询。

#### 问题 E：CSP 与 bridge 需要配套注入

小应用 HTML 由模型生成，不能假设模型总会写对 bridge 初始化逻辑。

修正方案：

- `persistWebAppArtifact()` 保存前，对 HTML 注入一段最小 bridge bootstrap。
- bootstrap 提供：

```js
window.KikiBridge = {
  ready(),
  saveState(state, event),
  patchState(patch, event),
  reportHeight(height)
}
```

- 模型可以直接调用 `window.KikiBridge.patchState(...)`。
- 即使模型忘记发 ready，bootstrap 也会在 DOMContentLoaded 自动发送 `ready` 和初始高度。

## Summary

目标是把当前“交互渲染区”从静态 blocks 升级为真正可执行的小应用区：用户可以在 iframe 内操作 HTML 小应用，小应用可以通过受控通道把交互数据保存到 KiKi，后续任务可以读取这些交互数据继续生成、分析或推进任务。

推荐第一版采用：

* **产物形态**：单文件 HTML 小应用。

* **运行方式**：sandbox iframe。

* **通信方式**：`postMessage` 受控通信。

* **状态保存**：宿主页面接收 iframe 事件，调用后端 API 保存到 SQLite / workspace。

* **后续任务使用**：任务 Runner 在 prompt 中读取并注入该小应用的 interaction state。

不建议第一版直接支持任意 React/Vite 构建。原因是当前项目没有构建沙箱、依赖安装隔离、超时队列、构建日志、失败降级等基础设施。先打通“HTML 小应用 + 状态桥 + 后续任务上下文”这条核心闭环，价值最大、风险最小。

## Current State Analysis

### 1. 双区域模型已经具备入口

当前结果呈现已经拆为：

* `interactive`：交互渲染区。

* `files`：文件区域。

相关文件：

* `src/types/kiki.ts`

* `src/types/taskResult.ts`

* `src/lib/taskResult/surfaces.ts`

* `src/components/task/GenericAgentResultView.tsx`

`InteractiveSurfaceKind` 已经预留：

```ts
export type InteractiveSurfaceKind =
  | "blocks"
  | "iframe"
  | "webapp"
  | "dashboard"
  | "form"
  | "table";
```

但当前 `GenericAgentResultView.tsx` 中 `InteractiveRenderSurface` 只渲染 `TaskResultBlockView`，还没有 iframe/webapp 实现。

### 2. Artifact 数据平面只能支持普通文件

当前 `ArtifactKind` 是：

```ts
export type ArtifactKind = "text_block" | "file" | "external_link";
```

相关文件：

* `src/types/artifact.ts`

* `src/lib/server/workspace/artifactStorage.ts`

* `src/lib/server/repositories/artifactsRepository.ts`

* `src/app/api/artifacts/[id]/route.ts`

当前能力：

* 可以保存单个文件。

* 可以通过 `/api/artifacts/[id]` 返回文件内容。

* 不区分普通文件与可执行小应用。

* 没有 `/api/artifacts/[id]/preview`。

* 没有 iframe 专用 CSP / sandbox 预览响应。

### 3. Prompt 已经提到 iframe/webapp，但没有产出协议

`src/lib/taskResult/schemaForPrompt.ts` 当前说明：

```txt
交互渲染区用于页面内渲染，当前通过 task_result.blocks 表达；未来可扩展为 iframe、webapp、dashboard、form、table 等。
```

但还缺少：

* 小应用 HTML 的返回格式。

* 小应用允许调用的 bridge API。

* 小应用状态保存协议。

* iframe/webapp surface 的 task\_result 示例。

### 4. 后续任务上下文已有可接入位置

任务执行 prompt 由 `src/lib/server/goalTaskPrompt.ts` 构造。

后续任务可以在这里注入：

* 当前任务已有 `taskResult`。

* 小应用最近一次保存的 interaction state。

* 用户在小应用中的关键操作事件。

这意味着“小应用交互数据用于后续任务生成”不需要重做 Runner 架构，只需要新增状态存储与 prompt 注入。

## 三种展现形式区别

### 1. 单文件 HTML

Agent 返回一个完整 `index.html`：

```html
<!doctype html>
<html>
  <head>
    <style>...</style>
  </head>
  <body>
    <div id="app"></div>
    <script>...</script>
  </body>
</html>
```

特点：

* 可以运行 JavaScript。

* 可以做表单、选择器、计算器、小游戏、交互报告、练习题、预算表。

* 不需要 npm install。

* 不需要 build。

* 最适合作为第一版。

限制：

* 不适合复杂工程化前端。

* 资源都要内联或通过白名单方式引用。

* 不支持任意第三方 npm 包。

### 2. 多文件静态包

Agent 返回：

```txt
index.html
style.css
app.js
assets/...
```

特点：

* 更接近真实静态网站。

* 结构更清晰。

* 可以拆分 JS/CSS。

限制：

* 需要新增 bundle 目录服务。

* 需要路径解析和目录安全校验。

* 比单文件多一层实现复杂度。

### 3. React/Vite 构建

Agent 返回源码工程：

```txt
package.json
src/App.tsx
vite.config.ts
...
```

系统执行：

```bash
pnpm install
pnpm build
```

特点：

* 能做最复杂的小应用。

* 可以复用 React 生态。

限制：

* 安全风险最高。

* 需要构建沙箱、超时、日志、依赖缓存、失败降级。

* 模型生成 package.json 的可靠性不可控。

* 不适合作为第一版。

## Recommended Architecture

### 核心架构

```txt
Task Result
  └── interactive surface: webapp
        └── webapp artifact
              ├── index.html
              ├── manifest.json
              └── state.json

Frontend
  └── SandboxedWebAppSurface
        └── iframe sandbox
              └── postMessage bridge

Backend
  ├── /api/artifacts/[id]/preview
  ├── /api/artifacts/[id]/state
  └── artifact_interaction_state

Next Task Runner
  └── reads saved interaction state
      injects into goalTaskPrompt
```

### 安全原则

第一版使用受控通信：

```tsx
<iframe
  sandbox="allow-scripts"
  src="/api/artifacts/[id]/preview"
/>
```

原则：

* 不加 `allow-same-origin`。

* iframe 内代码不能直接访问宿主 DOM。

* iframe 内代码不能直接调用 KiKi 后端 API。

* 所有状态读写必须走 `postMessage`。

* 宿主页面校验 message 来源、artifactId、schemaVersion、payload 大小。

* 后端只保存 JSON state，不执行 iframe 传来的代码。

## Data Model

### 1. Artifact 类型扩展

文件：`src/types/artifact.ts`

新增：

```ts
export type ArtifactKind =
  | "text_block"
  | "file"
  | "external_link"
  | "webapp";

export type WebAppArtifact = ArtifactCommon & {
  kind: "webapp";
  storageRelPath: string;
  entryFile: "index.html";
  manifest?: WebAppManifest;
};

export type WebAppManifest = {
  schemaVersion: 1;
  title: string;
  description?: string;
  bridgeVersion: 1;
  capabilities: Array<"state.read" | "state.write" | "event.emit" | "height.report">;
  initialState?: Record<string, unknown>;
};
```

`ArtifactRef` 新增：

```ts
previewUrl?: string;
surfaceKind?: "webapp";
```

### 2. 数据库扩展

文件：`src/lib/server/db/schema.ts`

新增 schema version，例如 `5`。

`artifacts` 表新增：

```sql
manifest_json TEXT
```

新增表：

```sql
CREATE TABLE IF NOT EXISTS artifact_interaction_state (
  artifact_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  task_id TEXT,
  instance_id TEXT,
  state_json TEXT NOT NULL,
  events_json TEXT,
  updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

用途：

* `state_json`：小应用当前状态快照。

* `events_json`：最近 N 条用户交互事件，第一版可限制 50 条。

* 后续任务 prompt 优先读取 `state_json`，必要时读取 `events_json`。

### 3. 产物落盘结构

当前文件 artifact 存在：

```txt
data/workspaces/conversations/<conversationId>/artifacts/<artifactId>/<filename>
```

webapp 建议：

```txt
data/workspaces/conversations/<conversationId>/artifacts/<artifactId>/
  index.html
  manifest.json
  state.initial.json
```

第一版只允许：

* `index.html`

* `manifest.json`

不允许：

* 任意子目录。

* 任意二进制资源。

* 远程脚本。

* 大于限制的 HTML。

建议限制：

* `index.html` 最大 300KB。

* `manifest.json` 最大 30KB。

* `state_json` 最大 100KB。

* 单次 event payload 最大 16KB。

## Backend APIs

### 1. WebApp 预览 API

新增文件：

```txt
src/app/api/artifacts/[id]/preview/route.ts
```

行为：

* 仅允许 `artifact.kind === "webapp"`。

* 返回 `index.html`。

* 返回前应确保 HTML 已注入 KikiBridge bootstrap；如果存储阶段已注入，则预览阶段只做读取。

* 强制响应头：

```http
Content-Type: text/html; charset=utf-8
Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; frame-ancestors 'self';
X-Content-Type-Options: nosniff
Cache-Control: no-store
```

说明：

* `connect-src 'none'` 禁止 iframe 直接联网。

* 需要与宿主通信只能 `postMessage`。

### 2. State 读写 API

新增文件：

```txt
src/app/api/artifacts/[id]/state/route.ts
```

支持：

```http
GET /api/artifacts/[id]/state
POST /api/artifacts/[id]/state
```

`GET` 返回：

```json
{
  "ok": true,
  "artifactId": "...",
  "state": {},
  "events": []
}
```

`POST` 输入：

```json
{
  "state": {},
  "event": {
    "type": "field.change",
    "payload": {},
    "createdAt": "ISO"
  }
}
```

校验：

* artifact 必须存在且 kind 为 `webapp`。

* JSON 必须是 object。

* payload 超限直接 413。

* 只保存数据，不执行任何代码。

* POST 必须由宿主页面调用，iframe 由于 CSP 与 sandbox 不能直接调用该 API。

* 第一版不做复杂用户鉴权，但必须校验 artifact 存在且 conversation/task/instance 归属完整。

### 3. Repository

新增文件：

```txt
src/lib/server/repositories/artifactInteractionRepository.ts
```

方法：

```ts
getArtifactInteractionState(artifactId)
upsertArtifactInteractionState(input)
appendArtifactInteractionEvent(input)
```

第一版可以把 state 和 events 一起 upsert，避免过度抽象。

## Frontend

### 1. 新增 SandboxedWebAppSurface

新增文件：

```txt
src/components/execution/SandboxedWebAppSurface.tsx
```

职责：

* 渲染 iframe。

* 设置 sandbox。

* 加载 `/api/artifacts/[id]/preview`。

* 监听 iframe `postMessage`。

* 调用 state API 保存状态。

* 向 iframe 回传当前 state。

* 支持 iframe 高度上报。

* 显示保存状态：`已保存 / 保存中 / 保存失败`。

* 使用 `event.source` 而不是 `event.origin` 校验 iframe 消息。

* 对 state 保存做 debounce，例如 300ms，避免每个输入字符都写 SQLite。

iframe：

```tsx
<iframe
  sandbox="allow-scripts"
  src={artifact.previewUrl}
  className="w-full rounded-xl border"
/>
```

### 2. Bridge 协议

iframe 发给宿主：

```ts
type WebAppToHostMessage =
  | {
      source: "kiki-webapp";
      type: "ready";
      artifactId: string;
      bridgeVersion: 1;
    }
  | {
      source: "kiki-webapp";
      type: "state.patch";
      artifactId: string;
      patch: Record<string, unknown>;
      event?: {
        type: string;
        payload?: Record<string, unknown>;
      };
    }
  | {
      source: "kiki-webapp";
      type: "state.replace";
      artifactId: string;
      state: Record<string, unknown>;
      event?: {
        type: string;
        payload?: Record<string, unknown>;
      };
    }
  | {
      source: "kiki-webapp";
      type: "height.report";
      artifactId: string;
      height: number;
    };
```

消息校验规则：

* `event.source` 必须等于当前 iframe 的 `contentWindow`。

* `message.source` 必须是 `"kiki-webapp"`。

* `message.artifactId` 必须等于当前 artifact id。

* `bridgeVersion` 必须是 `1`。

* `state`、`patch`、`payload` 必须是 JSON object。

* 单条消息序列化后不能超过 16KB。

宿主发给 iframe：

```ts
type HostToWebAppMessage =
  | {
      source: "kiki-host";
      type: "state.init";
      artifactId: string;
      state: Record<string, unknown>;
    }
  | {
      source: "kiki-host";
      type: "state.saved";
      artifactId: string;
      savedAt: string;
    }
  | {
      source: "kiki-host";
      type: "error";
      artifactId: string;
      message: string;
    };
```

### 3. WebApp 渲染入口

修改文件：

```txt
src/components/task/GenericAgentResultView.tsx
```

逻辑：

* `interactiveSurfaceKind === "webapp"`：渲染 `SandboxedWebAppSurface`。

* 找到 `taskResult.artifactRefs` 中 `kind === "webapp"` 的 artifact。

* 如果没有 webapp artifact，降级渲染 blocks。

伪代码：

```tsx
function InteractiveRenderSurface({ taskResult }) {
  if (taskResult.meta.interactiveSurfaceKind === "webapp") {
    const webappRef = taskResult.artifactRefs?.find((ref) => ref.kind === "webapp");
    if (webappRef) return <SandboxedWebAppSurface artifact={webappRef} />;
  }
  if (!taskResult.blocks.length) return null;
  return <TaskResultBlockView result={taskResult} />;
}
```

## Runner / Prompt

### 1. Prompt 协议扩展

修改：

```txt
src/lib/taskResult/schemaForPrompt.ts
src/lib/server/goalTaskPrompt.ts
```

新增 `webapp` 返回格式：

```json
{
  "webapp": {
    "title": "预算计算器",
    "description": "用户可输入预算参数并保存方案",
    "html": "<!doctype html>...",
    "initialState": {
      "budget": 300000,
      "downPayment": 100000
    }
  },
  "task_result": {
    "meta": {
      "surfaces": ["interactive"],
      "interactiveSurfaceKind": "webapp"
    },
    "blocks": [
      {
        "kind": "callout",
        "tone": "info",
        "text": "已生成可交互预算计算器。"
      }
    ]
  }
}
```

要求：

* HTML 必须单文件。

* 必须内联 JS/CSS。

* 不能引用远程脚本。

* 必须优先使用 `window.KikiBridge` 与宿主通信；底层由 bootstrap 封装 `window.parent.postMessage`。

* 必须监听 `state.init`。

* 用户关键操作必须发送 `state.patch` 或 `state.replace`。

* 模型不需要手写完整 bridge 初始化代码；系统会在保存 HTML 时注入最小 KikiBridge bootstrap。

### 2. 结果解析与持久化

修改：

```txt
src/lib/server/goalTaskRunner.ts
```

当前已有 `extractFileWriteSpecs(finalMessage)`。

新增：

```ts
extractWebAppSpec(finalMessage)
persistWebAppArtifact(input)
```

落盘后：

* 注册 `webapp` artifact。

* 写入初始 state。

* 将 `ArtifactRef` 放入 `taskResult.artifactRefs`。

* 设置：

```ts
taskResult.meta.surfaces = ["interactive"];
taskResult.meta.interactiveSurfaceKind = "webapp";
```

### 3. 后续任务注入交互状态

新增：

```txt
src/lib/server/taskResult/interactionContext.ts
```

或放在 server repository/goalTaskPrompt 附近。

职责：

* 根据当前 goal/task/conversation 查询相关 webapp artifact state。

* 生成简短 prompt 片段。

Prompt 注入示例：

```txt
【用户小应用交互状态】
- artifact: 购车预算计算器
- state:
{
  "budget": 320000,
  "monthlyPaymentLimit": 6000,
  "preferredModels": ["Model A", "Model B"]
}
- recentEvents:
  1. user.changed_budget
  2. user.selected_model

后续生成任务时必须把这些用户交互数据视为用户已明确提供的信息。
```

这能解决用户目标：“读取和保存用户和 html 交互数据，用于后续任务生成等。”

## Security & Constraints

### 第一版明确允许

* 单文件 HTML。

* 内联 CSS。

* 内联 JS。

* `postMessage`。

* 本地状态保存。

* iframe 自适应高度。

### 第一版明确禁止

* `allow-same-origin`。

* iframe 直接调用 KiKi API。

* iframe 直接联网。

* 远程 script。

* 任意 npm install。

* 任意 shell build。

* 读取本地文件。

* 上传二进制。

* Service Worker。

* localStorage 作为可信状态源。

### CSP 建议

```http
default-src 'none';
script-src 'unsafe-inline';
style-src 'unsafe-inline';
img-src data: blob:;
font-src data:;
connect-src 'none';
media-src data: blob:;
frame-ancestors 'self';
base-uri 'none';
form-action 'none';
```

### 为什么不是宽松同源

如果 iframe 允许 `allow-same-origin`，模型生成的 JS 会更容易访问同源资源、cookie、localStorage 或内部 API。当前项目是本地应用，但仍然不应让不可信代码直接拥有宿主权限。

## UX 设计

### 任务详情展示

交互区标题：

```txt
可执行小应用
```

状态条：

```txt
运行中 · 已保存 12:30
```

错误态：

```txt
小应用加载失败，已显示降级摘要
```

按钮：

* 重载小应用。

* 查看保存数据。

* 下载 HTML。

### 降级策略

如果 webapp 加载失败：

* 显示 `taskResult.blocks`。

* 文件区域仍可下载 HTML。

* 不抛 client-side exception。

如果 state 保存失败：

* UI 显示“保存失败，可重试”。

* iframe 仍可继续运行。

* 宿主保留最近一次未保存 payload，可重试一次。

## Mock Demo

新增一个 demo：

```txt
inst-surface-demo-webapp
```

展示：

* 一个“预算计算器”或“学习计划调整器”。

* 用户输入字段后 iframe 发送 `state.patch`。

* 宿主显示保存状态。

* 可通过 API 读取保存 state。

位置：

* `src/mocks/goals.ts`

* `src/mocks/conversations.ts`

## Proposed Changes

### 1. 类型层

文件：

* `src/types/artifact.ts`

* `src/types/taskResult.ts`

* `src/types/kiki.ts`

改动：

* 新增 `webapp` artifact kind。

* 新增 `WebAppManifest`。

* `ArtifactRef.kind` 支持 `webapp`。

* 确保 `interactiveSurfaceKind: "webapp"` 可被 normalize 保留。

### 2. 数据库与 Repository

文件：

* `src/lib/server/db/schema.ts`

* `src/lib/server/repositories/artifactsRepository.ts`

* `src/lib/server/repositories/artifactInteractionRepository.ts`

改动：

* schema version 升到 5。

* `artifacts` 增加 `manifest_json`。

* 新增 `artifact_interaction_state` 表。

* repository 支持 webapp artifact 与 state upsert/get。

### 3. Artifact Storage

文件：

* `src/lib/server/workspace/artifactStorage.ts`

改动：

* 新增 `persistWebAppArtifact()`。

* 保存 `index.html`、`manifest.json`。

* 生成 previewUrl：`/api/artifacts/[id]/preview`。

* 保存 initialState。

### 4. API

新增：

* `src/app/api/artifacts/[id]/preview/route.ts`

* `src/app/api/artifacts/[id]/state/route.ts`

改动：

* preview 返回带 CSP 的 HTML。

* state 支持 GET/POST。

* 限制 payload 大小。

* 只允许 webapp artifact。

### 5. 前端组件

新增：

* `src/components/execution/SandboxedWebAppSurface.tsx`

修改：

* `src/components/task/GenericAgentResultView.tsx`

* `src/components/execution/ArtifactRenderer.tsx`

* `src/components/conversation/TaskMessageCard.tsx`

改动：

* `InteractiveRenderSurface` 支持 webapp。

* webapp 不再只作为文件卡片展示，而是作为交互区运行。

* 卡片 chip 可显示 `可执行小应用`。

### 6. Prompt / Runner

修改：

* `src/lib/taskResult/schemaForPrompt.ts`

* `src/lib/server/goalTaskPrompt.ts`

* `src/lib/server/goalTaskRunner.ts`

改动：

* 增加 webapp 输出协议。

* 解析 `webapp.html`。

* 落盘为 webapp artifact。

* 把 artifactRef 挂到 taskResult。

* 后续任务 prompt 注入 saved state。

### 7. Validation

修改：

* `src/lib/taskResult/localValidation.ts`

* `src/lib/taskResult/parseAndRepair.ts`

改动：

* `interactiveSurfaceKind === "webapp"` 时，验收 interactive surface 不再只看 blocks。

* 必须存在 `webapp` artifact 或可解析 `webapp.html`。

* blocks 可作为降级摘要，但不是 webapp interactive 的唯一证据。

## Assumptions & Decisions

### 已锁定

* 第一版做单文件 HTML 小应用。

* iframe 使用受控通信。

* 不允许 `allow-same-origin`。

* 不做 npm install / build。

* 用户交互数据由宿主保存，不信任 iframe 自己的 localStorage。

* 后续任务通过服务端读取 state 注入 prompt。

### 暂不做

* React/Vite 构建。

* 多文件静态包。

* 第三方 npm 依赖。

* 联网小应用。

* iframe 直接调用 KiKi API。

* 复杂权限系统。

### 未来扩展

* M2：多文件静态包。

* M3：受限构建器，例如只允许内置模板和预装依赖。

* M4：更强的 postMessage API，例如文件选择、表单提交、任务触发。

## Verification Steps

### 静态检查

* 运行 `pnpm tsc --noEmit`。

* IDE diagnostics 为空。

### API 验证

* 创建 webapp artifact。

* `GET /api/artifacts/[id]/preview` 返回 HTML。

* 响应头包含 CSP。

* `GET /api/artifacts/[id]/state` 返回 initialState。

* `POST /api/artifacts/[id]/state` 可保存 JSON。

* 超大 payload 返回 413。

### UI 验证

* 任务详情中显示“可执行小应用”区域。

* iframe 能运行 JS。

* 用户修改字段后显示“保存中 / 已保存”。

* 刷新页面后 state 能恢复。

* webapp 加载失败时显示 blocks 降级摘要。

* 连续快速输入时只触发有限次数保存，不造成请求风暴。

### 后续任务验证

* 用户在小应用中保存偏好。

* 触发后续任务。

* prompt 中包含保存的 interaction state。

* Agent 不再重复询问已经通过小应用提供的信息。

* prompt 中注入的是压缩后的 state 摘要，不直接塞入无限事件日志。

### 安全验证

* iframe 内 `fetch('/api/runtime/state')` 失败。

* iframe 内不能访问 parent DOM。

* iframe 内不能读宿主 localStorage。

* 远程 script 不执行。

## Implementation Order

1. 扩展 artifact 类型和 DB schema。
2. 实现 webapp artifact 存储与 state repository。
3. 实现 preview/state API。
4. 实现 `SandboxedWebAppSurface` 与 postMessage bridge。
5. 接入 `GenericAgentResultView`。
6. 扩展 prompt 与 result parser。
7. 将 saved state 注入后续任务 prompt。
8. 增加 mock demo。
9. 跑类型检查和手工验证。

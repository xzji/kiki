# 双区域结果呈现模型修正规划

> 版本：v2
> 核心修正：结果呈现不再强行规定 `blocks` 永远是唯一主区域，也不规定文件永远只是附属。任务结果应拆成两个并列区域：**交互渲染区** 与 **文件区域**。二者可以同时存在，也可以只存在其中一种，具体取决于任务要求。

## Summary

当前 Artifact MVP 已经把文件产物引入 `taskResult.artifactRefs`，但现有计划里仍然把“页面 blocks 展示”视为永远的主产出，把“文件 Artifact”视为附加项。这比最初的“文件替代 blocks”更安全，但仍然不够准确。

更合理的产品模型是：

* **交互渲染区**：用于页面内可视化、结构化、交互式呈现。当前由 `taskResult.blocks` 承载，未来可扩展到 `iframe`、mini app、可交互表格、图表、表单、沙箱预览等。

* **文件区域**：用于文件型产物、导出物、附件、可下载报告、CSV、JSON、Markdown、ZIP 等。当前由 `taskResult.artifactRefs` 承载。

* 这两个区域是并列关系，不是替代关系，也不是固定主次关系。

* 一个任务可以只需要交互渲染区，例如“帮我做一个对比表并让我选择”。

* 一个任务可以只需要文件区域，例如“生成一个可下载 CSV 文件”。

* 一个任务也可以同时需要两者，例如“页面内展示分析摘要和表格，同时附带完整 Markdown 报告和 CSV 明细”。

因此，本次修正规划的目标是：把结果从“blocks + 附加文件”升级为“按任务要求声明和验收的双区域呈现模型”。

## Current State Analysis

### 1. 当前类型已经能表达双区域，但语义还不清晰

`src/types/taskResult.ts` 当前结构：

```ts
export type TaskResult = {
  blocks: ResultBlock[];
  artifactRefs?: ArtifactRef[];
  meta: ...
};
```

它实际上已经包含两个区域：

* `blocks`：当前交互渲染区的最小实现。

* `artifactRefs`：当前文件区域的最小实现。

问题不是类型完全不支持，而是命名和校验还没有明确“两个区域并列、按任务要求存在”。

### 2. 当前 Prompt 把 blocks 写成“唯一主产出容器”

`src/lib/taskResult/schemaForPrompt.ts` 当前写法：

```txt
task_result.blocks 是唯一主产出容器；artifacts 只能作为导出、下载或兼容镜像，不能替代 blocks。
```

这会误导模型和开发者：

* 如果任务只要求生成文件，也会被迫生成 blocks。

* 如果任务要求生成 iframe/webapp 预览，`blocks` 的概念不够承载未来交互渲染区。

* 如果任务同时需要页面交互和文件下载，容易把文件降级成“只是附件”，而不是任务要求的一部分。

### 3. 当前 `deliveryMode=file` 容易制造互斥模型

`src/lib/server/taskRunner/index.ts` 当前逻辑：

```ts
export function selectRunnerKind(task: Task): RunnerKind {
  return task.expectedResult?.deliveryMode === "file" ? "file_write" : "claude_json";
}
```

这会把任务拆成“文件模式”和“非文件模式”，与双区域模型冲突。

正确模型应该是：

* Runner 负责执行任务。

* 结果可以包含一个或多个呈现区域。

* 是否生成交互渲染区、文件区域，由任务的 `expectedResult.surfaces` 或等价字段决定。

### 4. 当前前端布局已经接近双区域

`src/components/task/GenericAgentResultView.tsx` 当前顺序：

```tsx
<TaskResultBlockView result={taskResult} />
<ArtifactRefList refs={taskResult.artifactRefs} />
```

这可以演进为：

```tsx
<InteractiveRenderSurface ... />
<FileArtifactSurface ... />
```

未来 `InteractiveRenderSurface` 内部不只渲染 blocks，也可以根据渲染目标切换为：

* blocks

* dashboard

* iframe

* webapp preview

* chart

* form

* table

### 5. 当前校验逻辑仍然没有“按任务要求验收”

`src/lib/taskResult/localValidation.ts` 当前围绕 `blocks` 是否为空做校验，这对双区域模型不够精确。

需要改成：

* 如果任务要求 `interactive`，则必须有可渲染内容。

* 如果任务要求 `files`，则必须有文件产物。

* 如果任务要求两者，则两者都要有。

* 如果任务只要求文件区域，则允许无 blocks。

* 如果任务只要求交互渲染区，则允许无文件。

## Proposed Changes

### 1. 引入结果呈现区域模型

文件：`src/types/kiki.ts`

建议在 `TaskExpectedResult` 中新增：

```ts
export type ResultSurfaceKind = "interactive" | "files";

export type InteractiveSurfaceKind =
  | "blocks"
  | "iframe"
  | "webapp"
  | "dashboard"
  | "form"
  | "table";

export type FileArtifactKind =
  | "markdown"
  | "text"
  | "csv"
  | "json"
  | "zip"
  | "html";

export type TaskExpectedResult = {
  ...
  surfaces?: ResultSurfaceKind[];
  interactiveSurface?: {
    required?: boolean;
    kind?: InteractiveSurfaceKind;
  };
  fileSurface?: {
    required?: boolean;
    acceptedKinds?: FileArtifactKind[];
    minCount?: number;
  };
};
```

MVP 映射规则：

* `surfaces` 未声明：默认 `["interactive"]`，保持现有任务行为。

* `deliveryMode === "file"`：兼容映射为 `surfaces=["files"]` 或 `surfaces=["interactive","files"]`，具体取决于是否有现有 `primaryFormat/requiredBlocks`。

* 当前 `interactiveSurface.kind` 只真正实现 `blocks`。

* `iframe/webapp/dashboard/form/table` 先作为前瞻类型，不在本次实现完整能力。

### 2. 调整 TaskResult 类型：让 blocks 成为交互渲染区的一种实现

文件：`src/types/taskResult.ts`

当前保留：

```ts
blocks: ResultBlock[];
artifactRefs?: ArtifactRef[];
```

建议新增轻量元信息：

```ts
meta: {
  surfaces?: Array<"interactive" | "files">;
  interactiveSurfaceKind?: "blocks" | "iframe" | "webapp" | "dashboard" | "form" | "table";
  fileSurfaceRequired?: boolean;
  ...
}
```

短期不引入破坏性 schema 变更：

* `blocks` 继续代表 `interactive:blocks`。

* `artifactRefs` 继续代表 `files`。

* `meta.surfaces` 用于表达这次结果实际包含哪些区域。

未来再演进为：

```ts
renderSurfaces: Array<InteractiveSurface | FileSurface>
```

但 MVP 不需要立刻做大迁移。

### 3. Prompt 从“结构化产物要求”改成“双区域产物要求”

文件：

* `src/lib/taskResult/schemaForPrompt.ts`

* `src/lib/server/goalTaskPrompt.ts`

新增 prompt 结构：

```txt
结果呈现区域要求：
1. 任务结果可以包含两个区域：interactive_render_area 和 file_area。
2. interactive_render_area 用于页面内渲染，当前通过 task_result.blocks 表达。
3. file_area 用于文件下载、预览和归档，当前通过 files 数组表达，系统会转成 task_result.artifactRefs。
4. 是否需要 interactive_render_area、file_area，取决于任务要求。
5. 如果任务要求两个区域，必须同时返回 blocks 和 files。
6. 如果任务只要求文件区域，可以只返回 files，但 summary/final_message 必须说明文件内容和用途。
7. 如果任务只要求交互渲染区，可以只返回 blocks，不需要 files。
8. 不要因为返回 files 就省略任务要求中的页面内可视化或交互内容。
9. 不要因为返回 blocks 就省略任务明确要求的可下载文件。
```

Prompt 注入逻辑：

* 默认任务：注入 `interactive=blocks` 要求。

* 文件型任务：注入 `files` 要求。

* 混合任务：同时注入 blocks 和 files 要求。

* 未来 iframe/webapp：注入 `interactiveSurface.kind=iframe/webapp` 的要求。

### 4. 替换 `deliveryMode` 为 `surfaces`

文件：

* `src/types/kiki.ts`

* `src/lib/server/taskRunner/index.ts`

* `src/lib/server/goalTaskRunner.ts`

* `src/lib/server/goalTaskPrompt.ts`

废弃方向：

```ts
deliveryMode?: "inline" | "file";
```

新增方向：

```ts
surfaces?: Array<"interactive" | "files">;
```

兼容函数：

```ts
function resolveExpectedSurfaces(expectedResult: TaskExpectedResult) {
  if (expectedResult.surfaces?.length) return expectedResult.surfaces;
  if (expectedResult.deliveryMode === "file") return ["files"];
  return ["interactive"];
}
```

注意：

* 不再用 `deliveryMode=file` 切 Runner。

* `files` 是结果区域之一，不是任务执行模式。

* 文件落盘是后处理能力，不是替代执行器。

### 5. 校验逻辑改为按 surface 验收

文件：`src/lib/taskResult/localValidation.ts`

新增：

```ts
const expectedSurfaces = resolveExpectedSurfaces(input.task.expectedResult);
const hasInteractiveSurface = blocks.length > 0 || hasFutureInteractivePayload(result);
const hasFileSurface = hasArtifactRefs(result) || hasParsedFiles(result);
```

校验规则：

* `expectedSurfaces` 包含 `interactive` 且 `hasInteractiveSurface=false`：critical。

* `expectedSurfaces` 包含 `files` 且 `hasFileSurface=false`：critical。

* `expectedSurfaces` 不包含 `interactive`：允许 blocks 为空。

* `expectedSurfaces` 不包含 `files`：允许 artifactRefs 为空。

* 如果同时要求两个区域，任一区缺失都要触发 repair。

错误码建议：

```ts
missing_interactive_surface
missing_file_surface
surface_requirement_mismatch
```

### 6. 执行后处理：所有任务都可解析 files，但是否必需看 surfaces

文件：`src/lib/server/goalTaskRunner.ts`

现状：

```ts
if (selectRunnerKind(input.task) === "file_write" && result.taskResult) {
  const files = extractFileWriteSpecs(finalMessage);
  ...
}
```

建议改为：

```ts
const expectedSurfaces = resolveExpectedSurfaces(input.task.expectedResult);
const files = extractFileWriteSpecs(finalMessage);

if (files.length > 0 && expectedSurfaces.includes("files")) {
  persist files and append artifactRefs;
}

if (expectedSurfaces.includes("files") && files.length === 0) {
  leave validation to localValidation / repair;
}
```

可选策略：

* 如果模型意外返回 files，但任务没要求 files，可以丢弃并记录日志。

* 如果希望更宽松，也可以允许 optional files，但本次建议先严格按 surfaces，避免所有任务乱生成附件。

### 7. 前端拆分两个区域组件

文件：

* `src/components/task/GenericAgentResultView.tsx`

* `src/components/execution/BlockRenderer.tsx`

* `src/components/execution/ArtifactRenderer.tsx`

建议新增：

```tsx
function InteractiveRenderSurface({ taskResult }) {
  if (taskResult.meta.interactiveSurfaceKind === "iframe") {
    return <IframePreviewSurface ... />;
  }
  return <TaskResultBlockView result={taskResult} />;
}

function FileArtifactSurface({ refs }) {
  return <ArtifactRefList refs={refs} />;
}
```

当前 MVP：

* `InteractiveRenderSurface` 只真正渲染 blocks。

* `iframe` 先保留类型和组件占位，不接入真实沙箱。

* `FileArtifactSurface` 渲染 file / external\_link。

UI 排布建议：

* 如果两个区域都有：先显示交互渲染区，再显示文件区域。

* 如果只有交互渲染区：只显示交互内容。

* 如果只有文件区域：显示一个文件区域，顶部说明“本任务产出为文件”。

* 文件区域标题用 `文件产物`，而不是“附件”，因为在 file-only 任务里它就是主要交付物。

### 8. 卡片 chip 文案按区域变化

文件：

* `src/components/conversation/TaskMessageCard.tsx`

* `src/components/conversation/ConversationMessageItem.tsx`

* `src/components/goal/TaskDetailBody.tsx`

建议：

* 只有文件区域：`文件产物 1 个`

* 交互 + 文件：`含文件产物 1 个`

* 未来 iframe/webapp：`可交互产物`

* 不再统一叫“附加产物”，因为文件区域可能是任务的唯一或主要要求。

### 9. Mock 演示改为双区域样例

文件：

* `src/mocks/goals.ts`

* `src/stores/goalStore.ts`

* `src/stores/conversationStore.ts`

建议保留 3 个 demo：

1. `interactive-only-demo`

   * 只有 blocks。

   * 用于验证无文件场景。

2. `file-only-demo`

   * 只有 artifactRefs / files。

   * 用于验证“任务只要求文件区域”。

3. `mixed-surface-demo`

   * 同时有 blocks 和 artifactRefs。

   * 用于验证“页面渲染 + 文件下载”。

这样比把文件挂到真实听力任务上更清晰。

## Assumptions & Decisions

### 已锁定决策

* 结果呈现分为两个区域：`交互渲染区` 和 `文件区域`。

* 两个区域可以同时存在，也可以只存在其中一个。

* 是否需要哪个区域，由任务要求决定，而不是由 artifact 是否存在反推。

* `blocks` 是当前交互渲染区的 MVP 实现，不代表未来交互渲染区只能是 blocks。

* 文件区域可以是附加项，也可以是唯一交付物，取决于任务要求。

* `iframe/webapp` 属于未来交互渲染区能力，不属于文件区域。

### 兼容决策

* 旧 `blocks` 和 `artifactRefs` 字段继续保留。

* 旧 `deliveryMode=file` 通过兼容函数映射到 `surfaces=["files"]`。

* 现有普通任务默认 `surfaces=["interactive"]`。

* 前端默认先展示交互渲染区，再展示文件区域；file-only 任务只展示文件区域。

### 不做事项

* 本次不实现真实 iframe sandbox。

* 本次不实现 webapp bundle 构建。

* 本次不引入全新的 `renderSurfaces[]` 大 schema 迁移。

* 本次不要求所有任务都生成文件。

## Verification Steps

### 类型与静态检查

* 运行 `pnpm tsc --noEmit`。

* 确认旧任务未声明 `surfaces` 时仍按 interactive blocks 展示。

* 确认旧 `deliveryMode=file` 仍能被兼容解析。

### 三类结果验证

1. 交互渲染区 only

   * 输入：任务只要求页面内展示。

   * 预期：有 blocks，无文件区域，校验通过。

2. 文件区域 only

   * 输入：任务只要求生成 CSV/Markdown 文件。

   * 预期：无 blocks 或仅有极简说明也允许；文件区域显示文件卡片，校验通过。

3. 双区域

   * 输入：任务要求页面内分析 + 可下载文件。

   * 预期：blocks 和 artifactRefs 同时存在；前端展示两个区域。

### 校验验证

* 任务要求 interactive，但没有 blocks：critical。

* 任务要求 files，但没有 files/artifactRefs：critical。

* 任务只要求 files，没有 blocks：不报 `empty_blocks`。

* 任务只要求 interactive，没有 files：不报文件缺失。

* 任务要求两者，缺任意一个都触发 repair。

### UI 验证

* 交互渲染区可单独展示。

* 文件区域可单独展示。

* 两个区域同时存在时布局清晰。

* chip 文案能区分 `文件产物` 与未来 `可交互产物`。

## Implementation Order

1. 在 `src/types/kiki.ts` 增加 `surfaces / interactiveSurface / fileSurface` 类型。
2. 新增 `resolveExpectedSurfaces()` 工具函数，兼容旧 `deliveryMode`。
3. 调整 `schemaForPrompt.ts`，把 prompt 改为“双区域产物要求”。
4. 调整 `goalTaskPrompt.ts`，根据 expected surfaces 注入对应要求。
5. 调整 `goalTaskRunner.ts`，把文件落盘改为 surface 后处理，而不是 RunnerKind 分支。
6. 调整 `localValidation.ts`，按 expected surfaces 验收。
7. 调整 `GenericAgentResultView.tsx`，拆分 `InteractiveRenderSurface` 和 `FileArtifactSurface`。
8. 调整卡片 chip 文案和渲染入口。
9. 重做 mock demo：interactive-only、file-only、mixed-surface。
10. 运行类型检查并手工验证三类结果。

***

## Deprecated v1 Notes

以下旧版内容保留为上下文，但执行时以 v2 双区域模型为准。v1 中“blocks 永远主、文件永远附加”的表述已废弃。

## Summary

当前实现已经具备 `taskResult.blocks + taskResult.artifactRefs` 共存的类型基础，但执行与校验语义仍然容易被理解成“进入 file mode 后，文件产物可以替代原来的 block 组件展示”。这与产品目标不一致。

本次修正目标：

* 明确 `blocks` 是主呈现面，始终承载用户可读、可交互、可验收的核心结果。

* 明确 `artifactRefs` 是附加产物面，用于下载、预览、归档、导出或承载大体积内容。

* 文件产物是否生成，取决于任务要求、导出格式、模型输出和 Runner 能力，但不改变 `blocks` 的主结果地位。

* 不再使用容易误导的“file runner / deliveryMode=file 表示一种互斥执行模式”的语义。

一句话：**文件型 Artifact 不是 blocks 的替代品，而是 blocks 之外的附加交付物。**

## Current State Analysis

### 1. 类型层已经支持共存

`src/types/taskResult.ts` 当前结构：

```ts
export type TaskResult = {
  blocks: ResultBlock[];
  artifactRefs?: ArtifactRef[];
  meta: ...
};
```

这说明数据模型已经允许同一个任务结果同时拥有：

* `blocks`：页面内结构化展示

* `artifactRefs`：文件 / 链接等外部产物引用

类型层方向是正确的，不需要推倒重来。

### 2. Prompt 层仍强调 blocks 是主产出

`src/lib/taskResult/schemaForPrompt.ts` 当前要求：

```txt
task_result.blocks 是唯一主产出容器；artifacts 只能作为导出、下载或兼容镜像，不能替代 blocks。
如果 artifacts 有内容，task_result.blocks 中必须能看到同等完整的用户可读产出。
```

这与用户提出的观点一致：文件产物可以存在，但不应该让原来的 block 组件形式消失。

问题在于新增的 `FILE_ARTIFACT_PROMPT_FRAGMENT` 有一句：

```txt
task_result.blocks 仍必须包含简短摘要；不需要重复完整文件正文。
```

这容易被模型理解成：只要有文件，blocks 就只需要摘要。这在“完整报告作为文件、页面只放摘要”的场景成立，但不应该成为通用规则。

### 3. 执行层把文件产物建模成 `file_write` 模式，语义偏窄

`src/lib/server/taskRunner/index.ts` 当前逻辑：

```ts
export function selectRunnerKind(task: Task): RunnerKind {
  return task.expectedResult?.deliveryMode === "file" ? "file_write" : "claude_json";
}
```

这把“是否需要附加文件产物”表达成 Runner 类型切换，容易造成两个问题：

* 产品语义上像是“文件任务”和“普通 blocks 任务”互斥。

* 后续如果一个普通分析任务也需要附带 CSV/JSON/Markdown 导出，就必须切到 `file_write`，不自然。

更合理的表达应该是：

* Runner 负责执行任务并生成结构化结果。

* Artifact 生成是任务结果的附加处理阶段。

* 是否允许/要求附加文件产物由 `artifactPolicy` 或 `expectedArtifacts` 表达，而不是 `deliveryMode=file`。

### 4. 本地校验对 artifactRefs 放宽了 `empty_blocks`

`src/lib/taskResult/localValidation.ts` 当前逻辑：

```ts
if (result?.taskResult && blocks.length === 0 && !result.awaitingUser && !hasArtifactRefs(result)) {
  issues.push(empty_blocks)
}
```

这等于允许“只要有 artifactRefs，blocks 为空也不算 critical”。这和“文件是附加项”冲突。

正确策略应该是：

* `blocks` 为空始终是问题。

* 如果有 `artifactRefs`，可以把 repair hint 改成“从 artifact 摘要或文件内容生成 blocks”，但不能跳过 `empty_blocks`。

* 对超大文件可以不把全文塞进 blocks，但至少要有标题、摘要、关键结论、文件说明和下一步动作。

### 5. 前端渲染顺序是对的

`src/components/task/GenericAgentResultView.tsx` 当前渲染：

```tsx
<TaskResultBlockView result={taskResult} />
<ArtifactRefList refs={taskResult.artifactRefs} />
```

这符合“先展示 blocks，后展示附件产物”的用户心智。

需要保留这个顺序，并进一步在 UI 文案上把 Artifact 区域标注为“附加产物 / 文件附件 / 可下载产物”，避免用户误以为这是主结果。

## Proposed Changes

### 1. 类型语义重命名：从 `deliveryMode` 改为附加产物策略

文件：`src/types/kiki.ts`

当前：

```ts
deliveryMode?: "inline" | "file";
```

建议改为：

```ts
artifactPolicy?: "none" | "optional" | "required";
expectedArtifactKinds?: Array<"file" | "external_link" | "text_block">;
```

含义：

* `none`：不期望附加 Artifact。

* `optional`：如果模型/Runner 产出了文件，允许落盘和展示。

* `required`：任务要求必须附加产物，例如“生成一份可下载 Markdown 报告 / CSV 数据表”。

* `expectedArtifactKinds`：声明期望的 Artifact 类型，MVP 先支持 `file / external_link / text_block`。

兼容策略：

* 保留旧字段 `deliveryMode?: "inline" | "file"` 一个版本。

* 如果旧数据里 `deliveryMode === "file"`，运行时映射为 `artifactPolicy: "required"` 和 `expectedArtifactKinds: ["file"]`。

* 新 prompt 与新逻辑不再继续写入 `deliveryMode`。

### 2. 执行语义调整：Artifact 生成从 Runner 模式变成后处理阶段

文件：

* `src/lib/server/taskRunner/index.ts`

* `src/lib/server/goalTaskRunner.ts`

* `src/lib/server/taskRunner/FileWriteRunner.ts`

当前：

* `selectRunnerKind(task)` 返回 `file_write` 或 `claude_json`。

* `goalTaskRunner.ts` 只有在 `selectRunnerKind(input.task) === "file_write"` 时才解析 `files[]` 并落盘。

建议：

1. 删除或弱化 `file_write` 作为 RunnerKind 的概念。
2. 新增函数：

```ts
function shouldPersistFileArtifacts(task: Task, parsedFiles: FileWriteSpec[]) {
  const policy = resolveArtifactPolicy(task.expectedResult);
  if (policy === "none") return false;
  if (policy === "required") return true;
  return parsedFiles.length > 0;
}
```

1. `goalTaskRunner.ts` 在所有正常任务路径中都可以解析 `files[]`，但只有策略允许时才落盘。
2. Artifact 落盘后只做：

```ts
result.taskResult = {
  ...result.taskResult,
  artifactRefs: [...existingRefs, ...newRefs],
};
```

不改变 `blocks` 的验收地位。

### 3. Prompt 调整：文件是“附加导出”，不是“主产物容器”

文件：

* `src/lib/taskResult/schemaForPrompt.ts`

* `src/lib/server/goalTaskPrompt.ts`

将 `FILE_ARTIFACT_PROMPT_FRAGMENT` 改名为：

```ts
ARTIFACT_ATTACHMENT_PROMPT_FRAGMENT
```

文案调整为：

```txt
附加文件产物要求：
1. task_result.blocks 始终是用户在页面中看到的主结果，必须覆盖任务核心交付物。
2. files 是附加产物，适合承载可下载报告、CSV、JSON、长文档、导出副本。
3. 生成 files 不代表可以省略 blocks；blocks 至少必须包含核心结论、摘要、关键表格/清单或文件内容索引。
4. 如果文件正文很长，blocks 不必逐字复述全文，但必须让用户不打开文件也能理解结论和文件用途。
5. 只有任务要求或导出格式需要时才返回 files；不要为了所有任务都生成文件。
```

`goalTaskPrompt.ts` 注入条件改为：

```ts
if artifactPolicy !== "none" 或 exportableFormats 包含 markdown/json/text/html
```

但 prompt 仍强调：“是否生成 files 取决于任务要求，不是必须”。

### 4. 校验策略修正：有 Artifact 也不能跳过 blocks

文件：`src/lib/taskResult/localValidation.ts`

当前应删除：

```ts
&& !hasArtifactRefs(result)
```

调整为：

```ts
if (result?.taskResult && blocks.length === 0 && !result.awaitingUser) {
  issues.push({
    code: "empty_blocks",
    severity: "critical",
    message: hasArtifactRefs(result)
      ? "结果包含附加产物，但缺少页面主展示 blocks。"
      : "task_result.blocks 为空，无法展示主产出。",
    repairHint: hasArtifactRefs(result)
      ? "基于附加产物的标题、摘要或文件内容生成页面可读 blocks；文件保留为附件。"
      : "把已有内容整理为可展示 blocks。",
  });
}
```

验收原则：

* `artifactRefs` 可以帮助修复 blocks。

* `artifactRefs` 不能替代 blocks。

### 5. 文件落盘后不自动兜底成“只有摘要”的 blocks

文件：`src/lib/server/taskRunner/FileWriteRunner.ts`

当前 `ensureFileWriteSummaryBlocks` 逻辑会在 blocks 为空时注入：

```ts
heading + callout
```

建议改为更严格：

* 不在 Runner 层自动把空 blocks 伪装成合格结果。

* 只在 repair 流程中生成合格 blocks。

* 如果保留兜底，也必须标记为 `status: "draft"` 或触发 `localValidation` repair，而不是直接 pass。

推荐实现：

```ts
export function ensureMinimumAttachmentBlocks(...) {
  // 只用于展示兜底，不用于跳过验收
}
```

并在 `structuredOutput` 中标记：

```ts
artifactAttachmentWarning: "files 已生成，但 blocks 需要补齐页面主展示。"
```

### 6. 前端 UI 文案调整：明确“附加产物”

文件：

* `src/components/execution/ArtifactRenderer.tsx`

* `src/components/execution/FileCard.tsx`

* `src/components/conversation/TaskMessageCard.tsx`

建议：

1. `ArtifactRenderer` 外层增加标题：

```tsx
附加产物
```

1. 会话卡片 chip 从：

```txt
产物 1 个
```

改为：

```txt
附加产物 1 个
```

1. 文件卡片按钮保留：

* `预览`

* `下载`

1. 不把 Artifact 区块放到 blocks 前面，避免主次颠倒。

### 7. 清理当前演示 mock，避免误导真实语义

文件：

* `src/mocks/goals.ts`

* `src/stores/goalStore.ts`

* `src/stores/conversationStore.ts`

当前为了演示，mock 中新增了：

* `ARTIFACT_DEMO_ID`

* `artifactDemoInstance()`

* `inst-listen-0426` 上的 demo `artifactRefs`

* store version bump 到 `4`

建议后续实现时：

* 保留一张明确命名为“Artifact Demo”的 mock 卡片可以用于开发演示。

* 不要把 artifact demo 挂到真实业务 mock（例如 `0426 限时听力精听分析`）上，以免误解为业务逻辑自然生成。

* 如果保留 demo，文案必须写明“演示：附加文件产物”。

## Assumptions & Decisions

### 已锁定决策

* `blocks` 是主展示和主验收对象。

* `artifactRefs` 是附加产物引用，不作为主展示的替代物。

* 文件产物是否生成由任务要求和导出需求决定。

* 即使生成文件，也仍然要保留 block 组件形式的页面展示。

* 对长文档，blocks 可以不复述全文，但必须提供用户可读的摘要、关键结论和文件说明。

### 兼容决策

* 旧 `deliveryMode=file` 不立即删除，先映射为 `artifactPolicy=required`。

* 旧 `artifactRefs` 数据继续有效。

* 前端展示顺序保持：先 blocks，后附加产物。

### 不做事项

* 不引入 DSL / iframe / webapp bundle。

* 不扩展到图片、视频、iOS、Android。

* 不做完整产物中心。

* 不把所有任务默认都生成文件。

## Verification Steps

### 类型与静态检查

* 运行 `pnpm tsc --noEmit`，必须通过。

* 检查 `TaskExpectedResult` 旧字段兼容，不破坏现有 mock 与运行时任务。

### Prompt 验证

构造 3 类任务：

1. 普通分析任务：只要求 blocks，不要求文件。

   * 预期：只生成 blocks；无 `files[]` 也正常。

2. 分析任务 + 可导出 Markdown。

   * 预期：blocks 完整展示核心结论；可选生成 `.md` 文件。

3. 明确要求“生成可下载 CSV/Markdown 文件”的任务。

   * 预期：blocks 展示摘要/关键结论；`artifactRefs` 附带文件卡片。

### 校验验证

* `blocks=[] + artifactRefs=[...]` 必须触发 `empty_blocks` critical。

* `blocks` 合格 + `artifactRefs` 存在必须通过本地校验。

* 文件落盘失败时，不影响 blocks 主结果展示，但应在 `structuredOutput` 或日志中记录 artifact 失败。

### UI 验证

* 会话卡片展示 `附加产物 N 个`。

* 任务详情中先展示 blocks，再展示“附加产物”文件卡片。

* 点击预览和下载仍可访问 `/api/artifacts/[id]`。

### 回归验证

* 现有等待用户输入任务不应因为 artifact 逻辑改变状态。

* 现有普通任务不应被强制生成文件。

* 旧数据中没有 artifactRefs 的任务展示不变。

## Implementation Order

1. 修改 `TaskExpectedResult`：新增 `artifactPolicy / expectedArtifactKinds`，兼容旧 `deliveryMode`。
2. 修改 prompt 文案：文件产物改为“附加文件产物”。
3. 修改 `goalTaskRunner.ts`：解析 `files[]` 变成通用后处理，而不是 `file_write` Runner 专属路径。
4. 修改 `localValidation.ts`：恢复 blocks 非空强校验，artifactRefs 只能作为 repair 线索。
5. 修改前端文案：`产物` 改成 `附加产物`，并给 Artifact 区域加标题。
6. 清理或重命名 mock demo，避免混入真实业务卡片。
7. 运行类型检查和手工 UI 验证。


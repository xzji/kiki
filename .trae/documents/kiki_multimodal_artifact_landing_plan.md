# KiKi 多形态产物落地规划（Phase 1 MVP 版）

> 来源参考：[docs/plans/kiki-multimodal-output-design.md](../../docs/plans/kiki-multimodal-output-design.md)
> 状态：方案稿 v1.1（已补 6 个修正点）
> 范围：把"模型 JSON 即终态产物"的现状，演进到"控制平面 / 数据平面 / 呈现平面三层解耦"，本规划仅覆盖 **MVP 阶段（M1+M2）**，重型形态（iOS App / Sandbox iframe / DSL）明确排除。

> v1.1 修订记录：补全了 normalizeTaskResult 字段保留、Runner 派发严格化、多渲染入口接入、localValidation 兼容、ArtifactRef 数据源单一化、Runner 进度事件 6 个工程细节，避免 M2 上线回归。

---

## 一、Summary（目标 + 范围 + 不做什么）

### 目标
- 让任务结果可以承载**真正的字节流产物**（文件、Markdown 文档、CSV、HTML 静态片段），而不只是塞进 `task_result.blocks` 的字符串。
- 在不破坏现有结构化 blocks 体验的前提下，让前端能**下载 / 预览**这些产物。
- 抽象出 `Runner` 接口，让 `goalTaskRunner.ts` 不再硬编码 Claude CLI 一种执行路径，为后续 `WebappBuildRunner / MediaRenderRunner` 留口子。

### 必做（M1+M2 范围）
1. **Artifact 类型** + **SQLite `artifacts` 表** + **物理存储** + **静态服务 API**。
2. `Runner` 接口 + 把现有 Claude CLI 执行路径搬入 `ClaudeJsonRunner`（**保持行为完全不变**作为兼容基线）。
3. 一种新 Runner：`FileWriteRunner`，让模型可以"产出 Markdown 文件"作为独立 Artifact。
4. 前端 `ArtifactRenderer` + `FileCardView`，能下载 / 跳转预览。
5. 现有 `task_result.blocks` 路径**完全保留**，新路径作为 additive 扩展。

### 明确不做（推迟到 M3+，本规划不展开）
- ❌ 路线 B（DSL `ui_tree`）—— 解析器是无底洞，路线 A 足够覆盖 80% 场景。
- ❌ 路线 C（Sandbox iframe）—— 单机本地版价值低，CSP / postMessage 复杂度高。
- ❌ iOS / Android / 视频 Runner —— 需要 macOS VM / ffmpeg 等基础设施，不在 ROI 区间。
- ❌ Evaluator 视觉回归 / lighthouse —— MVP 用"成功落盘 + 大小检查"作为最小验收。
- ❌ Feature Flag 双写 / 灰度 —— 单用户单机，直接 main 分支演进 + git revert 回滚即可。
- ❌ 用户交互回流（`useAgentAction` / `/api/agent/feedback`）—— 与本规划关系不强，独立做。

---

## 二、Current State Analysis（现状分析，基于实际代码）

### 2.1 类型定义现状

[src/types/taskResult.ts](../../src/types/taskResult.ts):
```
TaskResult.blocks: ResultBlock[]   // 唯一主产出容器
TaskResult.meta.primaryFormat: "structured_blocks" | "json" | "markdown" | "html" | "text" | "code"
```
8 种 block kind 全部死枚举；没有"二进制 / 文件 / URL"的安身之处。

[src/types/kiki.ts#L211-L217](../../src/types/kiki.ts#L211-L217):
```ts
export type TaskRunArtifact = {
  id: string;
  label: string;
  kind: "markdown" | "text" | "json" | "code" | "link" | "other";
  content?: string;   // 字符串内容
  href?: string;      // 或一个外部链接
};
```
**关键发现**：现有 `TaskRunArtifact` 已经存在，但只是"文本附件 + 链接"，没有任何持久化、没有元数据、没有静态服务。本规划等于把它**升级为一等公民**。

[src/lib/taskResult/legacyAdapter.ts#L52-L72](../../src/lib/taskResult/legacyAdapter.ts#L52-L72):
现有 `deriveLegacyTaskResult` 会把整个 `task_result` 序列化成一份 markdown，塞进 `artifacts[0].content`，等于**把 artifact 当成 blocks 的镜像**——这正是设计文档批评的"指令面 / 产物面没分离"。

### 2.2 执行链路现状

[src/lib/server/goalTaskRunner.ts](../../src/lib/server/goalTaskRunner.ts):
- 直接调用 [streamClaudeCli](../../src/lib/server/claudeCli.ts)，没有 Runner 抽象。
- 输出 `ParsedTaskRunnerResult.artifacts: TaskRunArtifact[]` 完全在内存里，**没有落盘、没有入库**。
- `task` 没有 `executionKind` 字段（设计文档假设有，但仓库里只有 `TaskResultViewKind`）。

[src/lib/server/workspace/conversationWorkspace.ts#L124-L129](../../src/lib/server/workspace/conversationWorkspace.ts#L124-L129):
```ts
export function ensureTaskWorkspace(input: ...) {
  ...
  ensureDir(path.join(taskWorkspaceDir, "artifacts"));
  return taskWorkspaceDir;
}
```
**关键发现**：`<task workspace>/artifacts/` 物理目录**已经预留了**，但现在没人往里面写东西。这意味着我们 Step 4 的存储层落地**几乎零成本**。

### 2.3 数据库现状

[src/lib/server/db/schema.ts](../../src/lib/server/db/schema.ts):
- 当前 `KIKI_DB_SCHEMA_VERSION = 3`。
- 只有 `runtime_jobs` 和 `runtime_state_snapshots` 两张表。
- 提供了 `KIKI_DB_MIGRATIONS` 数组，新增表只需追加 `version: 4`。
- `runtime_jobs.result_json` 是 TEXT，artifact 元数据可以从 result 里反向溯源。

### 2.4 渲染层现状

[src/components/execution/BlockRenderer.tsx](../../src/components/execution/BlockRenderer.tsx):
- `TaskResultBlockView({ result })` 是入口；只看 `result.blocks`。
- `BlockRenderer` 是 switch-case 死分发；改成"先 ArtifactRenderer 再 Block 兜底"成本可控。

[src/components/task/GenericAgentResultView.tsx](../../src/components/task/GenericAgentResultView.tsx):
- 接收 `artifacts?: unknown[]` 参数但**完全没渲染**（`void artifacts`），只渲染 `taskResult`。
- 这是我们要接入新渲染逻辑的位置。

[src/components/task/ExecutionResultBody.tsx#L255-L261](../../src/components/task/ExecutionResultBody.tsx#L255-L261):
- `instance.result?.artifacts` 已经被传下去了，但下游不消费。

### 2.5 Prompt 现状

[src/lib/taskResult/schemaForPrompt.ts](../../src/lib/taskResult/schemaForPrompt.ts):
明确写"task_result.blocks 是唯一主产出容器；artifacts 只能作为导出、下载或兼容镜像，不能替代 blocks"。
**这条要在 M2 prompt 改造里松动**，但松动的方式是"对特定任务类型才允许 file 类 artifact 作为主产出"，不是全局放开。

---

## 三、Proposed Changes（按文件粒度的具体改动）

### M1：数据平面骨架（约 5 个 PR 级改动）

#### 3.1 新建类型 `src/types/artifact.ts`（NEW）

**为什么**：`TaskRunArtifact` 已被现有代码大量引用，直接改会撕裂；新增 `Artifact / ArtifactRef` 与之并存，老路径继续用 `TaskRunArtifact`，新路径用 `ArtifactRef`。

**怎么做**：
```ts
export type ArtifactKind = "text_block" | "file" | "external_link";

export type ArtifactCommon = {
  id: string;                    // 全局唯一，前端用作 key + URL 拼接
  conversationId: string;
  taskId?: string;
  instanceId?: string;
  label: string;
  summary?: string;              // 一行摘要，回填上下文用
  createdAt: string;
};

export type FileArtifact = ArtifactCommon & {
  kind: "file";
  storageRelPath: string;        // 相对 conversation workspace 的路径
  mime: string;
  size: number;
};

export type ExternalLinkArtifact = ArtifactCommon & {
  kind: "external_link";
  url: string;
};

export type TextBlockArtifact = ArtifactCommon & {
  kind: "text_block";
  inlineContent: string;         // 兼容旧 TaskRunArtifact 文本内容
  language?: string;
};

export type Artifact = FileArtifact | ExternalLinkArtifact | TextBlockArtifact;

export type ArtifactRef = {
  id: string;
  kind: ArtifactKind;
  label: string;
  summary?: string;
  mime?: string;
  size?: number;
  previewUrl?: string;           // /api/artifacts/[id] 或外链
};
```

#### 3.2 修改 `src/types/taskResult.ts`

**为什么**：让 `TaskResult` 能挂载 ArtifactRef，但**不删除 blocks**。

**怎么做**：在 `TaskResult` 类型最后加可选字段：
```ts
artifactRefs?: ArtifactRef[];    // 新增；数据平面引用
```
不动 `blocks`、不动 `meta`。所有现有消费方零修改。

#### 3.2bis 修改 `src/lib/taskResult/parseAndRepair.ts`【修正点 #1，必做】

**为什么**：[normalizeTaskResult](../../src/lib/taskResult/parseAndRepair.ts#L152-L180) 是显式字段重建（白名单），任何不在白名单里的字段都会被静默丢弃。如果不补，`taskResult.artifactRefs` 一旦走过修复路径就会消失，导致前端拿不到 ArtifactRef。

**怎么做**：
- 在 `normalizeTaskResult` 返回对象中追加：
  ```ts
  artifactRefs: normalizeArtifactRefs(value.artifactRefs),
  ```
- 新增 `normalizeArtifactRefs(value: unknown): ArtifactRef[] | undefined`：要求 `id`、`kind ∈ ('file'|'external_link'|'text_block')`、`label` 三字段都是非空字符串；不合格条目过滤掉；为空数组返回 `undefined`。
- 同时检查 [src/lib/taskResult/localValidation.ts](../../src/lib/taskResult/localValidation.ts) 是否还有其他字段重建路径，若有需同步。

#### 3.3 数据库迁移 `src/lib/server/db/schema.ts`

**为什么**：Artifact 元数据要可查询、可关联 runtime_jobs，必须入库。

**怎么做**：
- `KIKI_DB_SCHEMA_VERSION` 从 3 → 4。
- 在 `KIKI_DB_BOOTSTRAP_SQL` 里追加 `CREATE TABLE IF NOT EXISTS artifacts (...)`。
- 在 `KIKI_DB_MIGRATIONS` 数组追加 `{ version: 4, sql: "CREATE TABLE IF NOT EXISTS artifacts ..." }`。

表结构：
```sql
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  task_id TEXT,
  instance_id TEXT,
  runtime_job_id TEXT,
  kind TEXT NOT NULL,            -- 'file' | 'external_link' | 'text_block'
  label TEXT NOT NULL,
  summary TEXT,
  storage_rel_path TEXT,         -- file 才有
  mime TEXT,
  size INTEGER,
  url TEXT,                      -- external_link 才有
  inline_content TEXT,           -- text_block 才有
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_conversation ON artifacts(conversation_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_instance ON artifacts(instance_id);
```

**注意**：使用 `IF NOT EXISTS`，对全新 DB 由 BOOTSTRAP_SQL 直接建表，对老 DB 由 migration 补建，幂等。

#### 3.4 新建 `src/lib/server/workspace/artifactStorage.ts`（NEW）

**为什么**：把"写文件 + 落 SQLite"的双写逻辑封一个函数；调用方（Runner）只关心"我有一段 bytes / 一个 URL"。

**怎么做**：暴露三个接口：
```ts
export function persistFileArtifact(input: {
  conversationId: string; taskId?: string; instanceId?: string;
  runtimeJobId?: string;
  label: string; summary?: string;
  filename: string;              // 比如 'research-report.md'
  mime: string;
  bytes: Buffer | string;
}): FileArtifact;

export function persistExternalLink(input: {...}): ExternalLinkArtifact;

export function persistTextBlock(input: {...}): TextBlockArtifact;
```

物理路径：`<conversationWorkspaceDir>/artifacts/<artifactId>/<filename>`。
- 复用 [ensureConversationWorkspace](../../src/lib/server/workspace/conversationWorkspace.ts#L83) + [writeTextFileAtomic](../../src/lib/server/workspace/conversationWorkspace.ts#L72)。
- 写完文件后，立即 INSERT 一条 `artifacts` 记录。
- 失败时清理半成品文件。

新增一个 repository：`src/lib/server/repositories/artifactsRepository.ts`，封装 SQL CRUD，参考 [runtimeJobsRepository.ts](../../src/lib/server/repositories/runtimeJobsRepository.ts) 写法。

#### 3.5 静态服务 API `src/app/api/artifacts/[id]/route.ts`（NEW）

**为什么**：前端需要一个 stable URL 来下载 / 预览 / iframe 嵌入。

**怎么做**：
```ts
export async function GET(_req, { params }) {
  const artifact = await getArtifactById(params.id);
  if (!artifact) return new Response('Not Found', { status: 404 });

  if (artifact.kind === 'external_link') {
    return Response.redirect(artifact.url, 302);
  }
  if (artifact.kind === 'text_block') {
    return new Response(artifact.inlineContent, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  if (artifact.kind === 'file') {
    const fullPath = resolveArtifactFullPath(artifact);   // 内部做 assertPathInsideWorkspace
    const stream = fs.createReadStream(fullPath);
    return new Response(stream, {
      headers: {
        'Content-Type': artifact.mime,
        'Content-Length': String(artifact.size),
        'Content-Disposition': `inline; filename="${encodeURIComponent(path.basename(artifact.storageRelPath))}"`,
      },
    });
  }
}
```

**安全要点**：必须用 [assertPathInsideWorkspace](../../src/lib/server/workspace/conversationWorkspace.ts#L64) 防路径穿越；不接受任何 query 参数控制路径。

#### 3.6 前端渲染 `src/components/execution/ArtifactRenderer.tsx`（NEW）

**为什么**：基于 ArtifactRef 渲染下载卡片；不影响 BlockRenderer。

**怎么做**：
```tsx
export function ArtifactRenderer({ refs }: { refs: ArtifactRef[] }) {
  if (!refs?.length) return null;
  return (
    <div className="space-y-2">
      {refs.map((ref) => {
        if (ref.kind === 'file') return <FileCard key={ref.id} ref_={ref} />;
        if (ref.kind === 'external_link') return <LinkCard key={ref.id} ref_={ref} />;
        return null;   // text_block 仍由 blocks 渲染
      })}
    </div>
  );
}
```

`FileCard` 提供：文件名、大小、mime 图标、`下载` 按钮（指向 `/api/artifacts/<id>`）、对 `.md` mime 显示行内 Markdown 预览（复用 [MarkdownRenderer.tsx](../../src/components/common/MarkdownRenderer.tsx)）。

修改 [GenericAgentResultView.tsx](../../src/components/task/GenericAgentResultView.tsx)：
```tsx
return (
  <div className="space-y-4">
    {taskResult ? <TaskResultBlockView result={taskResult} /> : null}
    {taskResult?.artifactRefs?.length ? <ArtifactRenderer refs={taskResult.artifactRefs} /> : null}
  </div>
);
```

#### 3.6bis 多入口接入 ArtifactRenderer【修正点 #3，必做】

**为什么**：现状有多个 task_result 消费组件，只改 `GenericAgentResultView` 会让 ArtifactRef 在部分页面看不到。

**需要同步接入的入口**（统一通过 `taskResult.artifactRefs` 读取）：
- [src/components/task/ExecutionResultBody.tsx](../../src/components/task/ExecutionResultBody.tsx)（任务执行结果主面板）
- [src/components/goal/TaskDetailBody.tsx](../../src/components/goal/TaskDetailBody.tsx)（目标模式任务详情）
- [src/components/conversation/TaskMessageCard.tsx](../../src/components/conversation/TaskMessageCard.tsx)（会话流任务卡片，至少做一个折叠摘要）

**怎么做**：抽出一个轻量的 `<ArtifactRefList refs={...} />` 子组件供以上三处复用；位置统一放在 blocks 渲染之后、notification 之前。
TaskMessageCard 由于卡片高度受限，仅展示"产物 N 个"chip + 点击跳转到详情页（不内联渲染 FileCard）。

#### 3.7 端到端联调（M1 收尾）

**手工验证**：
- 在某个真实任务运行后，**手动**往 `artifacts` 表 INSERT 一条 `kind='file'` 记录、往磁盘写一个 markdown，把 ArtifactRef 塞进 `task_result.artifactRefs`。
- 刷新前端，应能看到 FileCard 并下载。

至此 M1 完成；Runner 改造未启动，现有任务行为零回归。

---

### M2：Runner 抽象 + FileWriteRunner（约 4 个 PR 级改动）

#### 3.8 新建 `src/lib/server/taskRunner/Runner.ts`（NEW）

**为什么**：把"如何执行任务"从 [goalTaskRunner.ts](../../src/lib/server/goalTaskRunner.ts) 解耦，使后续接入 Webapp / Media Runner 时不必再改主循环。

**怎么做**：
```ts
export interface RunnerInput {
  goal: Goal; subGoal: SubGoal; task: Task; instance: TaskInstance;
  runtimeEnv: RuntimeEnvironment;
  conversationWorkspaceDir: string; taskWorkspaceDir: string;
  signal?: AbortSignal;
  onEvent?: (event: ClaudeStreamEvent) => void;
}

export interface RunnerOutput {
  rawOutput: string;
  parsed: ParsedTaskRunnerResult;        // 复用现有类型
  artifactRefs: ArtifactRef[];           // 新增
  trajectory: ExecutionTrajectoryStep[];
}

export interface Runner {
  readonly kind: string;                 // 'claude_json' | 'file_write' | ...
  run(input: RunnerInput): Promise<RunnerOutput>;
}

export function selectRunner(task: Task): Runner;
```

派发规则（M2 严格版，避免回归）【修正点 #2，必做】：
- **默认**永远是 `ClaudeJsonRunner`，不主动切。
- **仅当**任务 `expectedResult` 显式声明一个新的 opt-in 信号 `deliveryMode === 'file'` 时，才派发 `FileWriteRunner`。
- 该字段为新增可选字段（在 [src/types/kiki.ts](../../src/types/kiki.ts) 的 `TaskExpectedResult` 上加 `deliveryMode?: 'inline' | 'file'`），缺省即 `'inline'`，行为与现状完全一致。
- M2 阶段**不开放**模型自主决定 `deliveryMode`，仅允许通过手工 Mock / 测试 fixture 设置该字段，确保灰度可控。
- 不依赖 `primaryFormat === 'markdown'` 这种宽松条件，因为现有任务（调研类）很可能已经把 `primaryFormat` 设成 markdown 但仍期望走 blocks 路径。
- 派发实现就是一个 if-else 函数，**不需要新增 task.executionKind 字段**，避免类型扩散。

#### 3.9 新建 `src/lib/server/taskRunner/ClaudeJsonRunner.ts`（NEW）

**为什么**：把现有 `streamClaudeCli + parseClaudeJson + acceptance` 流水线**原样**搬进来，作为 Runner.run 实现。

**怎么做**：从 [goalTaskRunner.ts](../../src/lib/server/goalTaskRunner.ts) 中抽出"执行 prompt → 解析 → 修复 → 验证"那段（约 200-400 行），封装成 `ClaudeJsonRunner`；`goalTaskRunner.ts` 改为：
```ts
const runner = selectRunner(task);
const output = await runner.run(input);
// 后续 acceptance / finalize 逻辑保持原样
```

**关键约束**：M2 的 ClaudeJsonRunner 必须保持**完全相同的 ParsedTaskRunnerResult**，做对照回归。

#### 3.10 新建 `src/lib/server/taskRunner/FileWriteRunner.ts`（NEW）

**为什么**：让"产出 Markdown 报告"任务真正写文件。

**怎么做**：
- 内部仍调用 Claude CLI，但 prompt 用一个**新的 schema fragment**（见 3.11）。
- 模型 JSON 输出形如：`{ task_result: {...}, files: [{ filename, mime, content }] }`。
- 收到后调用 `persistFileArtifact` 写盘，把生成的 ArtifactRef 注入返回的 `RunnerOutput.artifactRefs`。
- 同时仍然产出 `task_result.blocks`（一段 callout/heading 概述），方便消息列表展示。
- **若模型偷懒只输出 files 不输出 blocks**：FileWriteRunner 兜底自动注入一段最小 blocks（`heading: 文件标题` + `callout(info): 产物 N 个，请在下方下载`），保证 `blocks.length > 0`，避开 [localValidation](../../src/lib/taskResult/localValidation.ts#L147-L155) 的 `empty_blocks` critical 校验（修正点 #4）。
- **进度事件**（修正点 #6）：在落盘前 `onEvent({ type:'message', content:'正在写入 X.md ...' })`，落盘后 `onEvent({ type:'message', content:'已生成 N 个文件产物' })`，以保证现有 trajectory 时间线连贯，前端 SSE 显示无空档。

#### 3.10bis localValidation 与 FileWriteRunner 的兼容【修正点 #4，必做】

**为什么**：[localValidation.ts](../../src/lib/taskResult/localValidation.ts#L147-L155) 强制 `task_result.blocks 非空`，否则发出 `empty_blocks` critical issue 触发 semantic repair，对 FileWriteRunner 是无谓的二次调用。

**双保险方案**：
1. **Runner 内置兜底**（首选）：FileWriteRunner 在收到模型输出后，若 `blocks` 为空且 `files` 非空，**自动注入**：
   ```ts
   blocks = [
     { kind:'heading', text: title, level: 2 },
     { kind:'callout', tone:'info', text: `已生成 ${files.length} 个文件产物，请在下方下载查看。` },
   ];
   ```
2. **Validation 软化**（兜底）：在 `validateTaskResultLocally` 中，当输入包含非空 `artifactRefs` 时，把 `empty_blocks` 从 `critical` 降级为 `warning`，避免触发 semantic repair。

两者同时实施：方案 1 让正常路径不触发，方案 2 在异常情况下也不阻塞。

#### 3.11 Prompt 改造 `src/lib/taskResult/schemaForPrompt.ts`

**为什么**：让模型知道"file 形态任务可以输出文件 artifact 数组"。

**怎么做**：增加一个 `FILE_ARTIFACT_PROMPT_FRAGMENT`，仅在 `FileWriteRunner` 拼 prompt 时注入：
```
当任务的主交付物是一份完整的 Markdown 文档/报告时，可以使用 files 字段输出文件产物：
files: [{ filename, mime, content }]
- filename：合法的相对文件名，必须以 .md/.txt/.csv/.json 结尾
- content：文件正文（UTF-8）
此时 task_result.blocks 仍需提供一段简短摘要（heading + callout），但可不复述全文。
```

[schemaForPrompt.ts](../../src/lib/taskResult/schemaForPrompt.ts) 中"task_result.blocks 是唯一主产出容器"那条只在 ClaudeJsonRunner 默认路径生效；FileWriteRunner 路径用拼接好的新 fragment 覆盖。

#### 3.12 把 ArtifactRef 串到 TaskInstance

**为什么**：让前端能拿到 ArtifactRef 渲染。

**怎么做**：
- `goalTaskRunner.ts` finalize 时把 `output.artifactRefs` 写入 `taskResult.artifactRefs`。
- 不动 `TaskInstanceResult.artifacts`（旧字段保留兼容）。
- `task_result.json` 落盘时 artifactRefs 一并持久化（[writeTaskRunSnapshot](../../src/lib/server/workspace/conversationWorkspace.ts#L167)）。

---

## 四、Assumptions & Decisions（关键决策点）

| 决策点 | 选择 | 替代方案 | 理由 |
|---|---|---|---|
| ArtifactKind 范围 | M1+M2 只做 `file / external_link / text_block` 三种 | 全部 9 种（webapp_bundle/ios_app/...） | 砍范围保交付；后续每加一种 kind 单独立 PR |
| 是否新增 Artifact 类型 vs 改 TaskRunArtifact | 并存（新增 Artifact，TaskRunArtifact 保留） | 直接重命名 | 现有代码大量引用 TaskRunArtifact，改名风险高 |
| **前端 ArtifactRef 数据源**【修正点 #5】 | **统一读 `instance.result.taskResult?.artifactRefs`** | 同时读旧 `instance.result.artifacts` | 单一字段避免双源歧义；旧 `result.artifacts` 字段保留但不渲染，仅供 legacy 调试与 trajectory 导出 |
| Runner 派发规则 | **严格 opt-in**：`expectedResult.deliveryMode === 'file'` 才走 FileWriteRunner【修正点 #2】 | 看 `primaryFormat === 'markdown'` | 后者过宽会误命中现有调研类任务 |
| Feature Flag | 不加 | 加 `KIKI_FEATURE_MULTIPLANE` env | 单机本地版，灰度无意义 |
| 静态服务路径 | `/api/artifacts/[id]` 单一端点 | 拆 download/preview/manifest 三端点 | YAGNI；MVP 一个端点够用 |
| Evaluator | 不做（FileWriteRunner 仅检查 `bytes.length > 0` 和 mime） | headless Chromium 截图 | 远超 MVP 需要 |
| 跨域 / 鉴权 | 同源，沿用 Next.js 默认 | 加 token 鉴权 | 单用户本地，沿用现有信任边界 |
| 旧任务兼容 | 完全 additive：不删字段、不改 prompt 默认行为 | 全量迁移 | 单机数据迁移 ROI 低；让旧任务继续按 blocks 渲染 |
| `empty_blocks` 校验【修正点 #4】 | Runner 内置兜底注入 + Validation 在有 artifactRefs 时降级为 warning | 完全跳过校验 | 双保险，兼顾正常与异常路径 |

### 关键假设
1. SQLite 迁移机制能正确处理 schema 升级（已被 v2/v3 验证）。
2. 模型在 FileWriteRunner 路径下能稳定输出 `files` 字段（如失败，fallback 到 blocks，不阻塞任务）。
3. 单个 file artifact 大小通常 < 1MB（MVP 不做大文件分片 / 流式）。

---

## 五、Verification（验证步骤）

### M1 验收
- [ ] `pnpm tsc --noEmit` 通过。
- [ ] DB 迁移：删除 `data/kiki.db` 后重启，`artifacts` 表正确创建；保留旧 DB 时，schema 自动升级到 v4。
- [ ] 手工 INSERT 测试：往 `artifacts` 表写一条 `kind='file'` 记录 + 落盘 markdown，访问 `GET /api/artifacts/<id>` 能拿到正确 mime + 内容。
- [ ] 现有任务跑一轮，行为完全无变化（ArtifactRenderer 不出现，BlockRenderer 正常渲染）。
- [ ] 在某个 task 的 `result.json` 里手工注入 `artifactRefs: [...]`，前端正确展示 FileCard。
- [ ] **【修正点 #1 验收】** 把含 artifactRefs 的 task_result 喂给 `normalizeTaskResult`，输出仍保留 artifactRefs；不合规条目被过滤但不影响其他字段。
- [ ] **【修正点 #3 验收】** ExecutionResultBody / TaskDetailBody / TaskMessageCard 三个入口都能看到产物（卡片或 chip 形式）。

### M2 验收
- [ ] 跑 5 个原有真实任务（信息类 + 决策类各几个），ClaudeJsonRunner 路径行为完全等价（对比 trajectory.json + result.json）。
- [ ] **【修正点 #2 验收】** 把 5 个原有任务的 `expectedResult.deliveryMode` 全部不动（缺省 inline），跑一遍验证**没有任何任务**意外切到 FileWriteRunner。
- [ ] 跑 1 个新设计的"调研报告"任务（手工把 `expectedResult.deliveryMode` 设为 `'file'`），FileWriteRunner 产出真实 .md 文件、能在前端下载、`task_result.blocks` 仍有简短摘要。
- [ ] 失败容错：模型不返回 files 字段时，FileWriteRunner 自动 fallback 成 blocks-only 模式，不报错。
- [ ] **【修正点 #4 验收】** 模型只输出 files 不输出 blocks 时，FileWriteRunner 兜底注入 blocks，`empty_blocks` 校验不触发 critical；即使 Runner 兜底失败，validation 降级也能保证不进入 semantic repair。
- [ ] **【修正点 #6 验收】** FileWriteRunner 落盘前后各发一次进度事件，前端 trajectory 时间线可见"正在写入 / 已生成"两条。
- [ ] Worker 重启后，进行中的任务能正确 resume（不影响现有 lease 逻辑）。
- [ ] 数据库表 `artifacts` 行数随任务运行正确增长，runtime_job_id 关联可用。

### 回滚方案
- M1：`git revert` Schema 改动 + 删除新 API/组件即可，旧任务无感知（artifactRefs 是可选字段）。
- M2：`selectRunner` 强制返回 `ClaudeJsonRunner` 即可绕过 FileWriteRunner，无需 revert。

---

## 六、文件清单（NEW / EDIT）

### NEW（11 个文件）
- `src/types/artifact.ts`
- `src/lib/server/workspace/artifactStorage.ts`
- `src/lib/server/repositories/artifactsRepository.ts`
- `src/app/api/artifacts/[id]/route.ts`
- `src/components/execution/ArtifactRenderer.tsx`
- `src/components/execution/FileCard.tsx`
- `src/components/execution/LinkCard.tsx`
- `src/lib/server/taskRunner/Runner.ts`
- `src/lib/server/taskRunner/ClaudeJsonRunner.ts`
- `src/lib/server/taskRunner/FileWriteRunner.ts`
- `src/lib/server/taskRunner/index.ts`（导出 selectRunner）

### EDIT（8 个文件）
- `src/types/taskResult.ts`（加可选 `artifactRefs?`）
- `src/types/kiki.ts`（在 `TaskExpectedResult` 加可选 `deliveryMode?: 'inline' | 'file'`，**修正点 #2**）
- `src/lib/server/db/schema.ts`（version 4 + artifacts 表）
- `src/lib/server/goalTaskRunner.ts`（接入 selectRunner，抽出执行流水线，finalize 时回写 artifactRefs）
- `src/lib/taskResult/parseAndRepair.ts`（保留 artifactRefs 字段 + normalizeArtifactRefs，**修正点 #1**）
- `src/lib/taskResult/localValidation.ts`（在有 artifactRefs 时把 `empty_blocks` 降级为 warning，**修正点 #4**）
- `src/lib/taskResult/schemaForPrompt.ts`（增加 FILE_ARTIFACT_PROMPT_FRAGMENT）
- `src/components/task/GenericAgentResultView.tsx` + `ExecutionResultBody.tsx` + `goal/TaskDetailBody.tsx` + `conversation/TaskMessageCard.tsx`（接入 ArtifactRenderer / ArtifactRefList，**修正点 #3**；最后这 4 个组件改动量小，统一计为一项 EDIT）

---

## 七、不在本规划范围（明确推迟）

如评审通过，**M3 起再启动**：
- `WebappBuildRunner`（Vite 构建静态网页 + iframe 预览）。
- 用户交互回流（`useAgentAction` + `/api/agent/feedback`）。
- 路线 B（DSL `ui_tree`）/ 路线 C（Sandbox iframe）。
- iOS / Android / 视频形态。
- 高级 Evaluator（headless 截图、视觉回归）。
- correlationId 全链路 trace UI。

---

## 八、一句话总结

> **M1 把 Artifact 升级为有元数据、能落盘、能下载的一等公民；M2 把执行链路抽象成 Runner，并用 FileWriteRunner 打通"模型产文件 → 用户下载"的最小闭环。其它都不做。**

# 方案 1：呈现层 — Block JSON + Artifact 沙箱

> 目标：用一组**可枚举、可组合的结构化原语**承载所有任务产物；长尾、富交互场景用**严格沙箱化的 Artifact**作为逃生舱。

---

## 1. 设计动机

KiKi 拆出的任务是异构的：买 SUV 要对比车型、做 iOS App 要管理代码、备孕要追踪指标。**不可能为每种长程目标的产物预定义一类 UI**。

正确的抽象层次不是"任务类型 → 专属 UI"，而是"信息形态 → 通用渲染原语"。类比：HTML 之所以能表达所有网页，不是因为它枚举了"新闻页/购物页/博客页"，而是因为它有 `<div> <ul> <table> <form>` 这些可组合原语。本方案就是给任务产物领域引入这套"原语层"。

| 旧思路 | 新思路 |
|---|---|
| 任务 → 预定义 resultType → 专属 UI | 任务 → 运行时声明的"信息结构" → 通用 UI 原语组合 |
| 枚举具体产物（抽认卡、草稿、确认） | 枚举抽象原语（heading/comparison_table/decision/action_request…） |
| Agent 受限于平台想到的类型 | Agent 自己组装产物结构，平台只保证"能渲染" |

---

## 2. 与现有模块的关系

| 现有 | 改造方式 |
|---|---|
| `src/types/` 里的 `Task.resultType` 枚举 | 增加 `expectedOutputSketch: string`，`resultType` 保留为可选"渲染优化提示" |
| `src/components/execution/{flashcard,draft_review,confirm_action}` | 保留为模板组件；新增 `BlockRenderer` 作为默认入口；模板组件改造为"当 blocks 序列匹配特定模式时被自动选用"的渲染优化项 |
| `src/lib/server/goalPlanning.ts` | 在生成任务时多输出 `expectedOutputSketch`，让用户和执行期 Agent 对产物形态对齐 |
| `src/lib/server/goalTaskRunner.ts` | 输出从字符串/单一对象升级为 `TaskResult { blocks[] }` |
| `runtime_jobs.result` 列 | JSON 文本，schema 升级为 `TaskResult` v1 |

---

## 3. 数据模型

新增 `src/types/taskResult.ts`，用 zod 一次定义、TS 类型 + JSON Schema + Claude system prompt 三处复用：

### 3.1 Block 原语清单（首批 17 种）

| kind | 用途 |
|---|---|
| `heading` | 段落标题 |
| `paragraph` | 普通段落，可附引用 |
| `markdown` | 富文本段落 |
| `list` | 有序/无序列表 |
| `key_value` | 属性对（联系方式、关键参数） |
| `comparison_table` | 多方案对比 |
| `checklist` | 带勾选的清单 |
| `timeline` | 时间线/里程碑 |
| `decision` | 多选项决策点 |
| `action_request` | 副作用动作请求（与方案 2 联动） |
| `attachment` | 附件 |
| `media` | 图/音/视频 |
| `code` | 代码片段 |
| `chart` | Vega-Lite 图表 |
| `embed` | 第三方嵌入 |
| `callout` | 提示/警告/风险卡 |
| `artifact` | 沙箱化富交互产物（逃生舱） |

### 3.2 zod schema 全文

```ts
import { z } from 'zod';

const Source = z.object({
  title: z.string(),
  url: z.string().url(),
  snippet: z.string().optional(),
});

const Cell = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.object({ text: z.string(), tone: z.enum(['default','good','bad','warn']).optional() }),
]);

const HeadingBlock = z.object({
  kind: z.literal('heading'),
  text: z.string(),
  level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
});

const ParagraphBlock = z.object({
  kind: z.literal('paragraph'),
  text: z.string(),
  citations: z.array(Source).optional(),
});

const MarkdownBlock = z.object({ kind: z.literal('markdown'), content: z.string() });

const ListBlock = z.object({
  kind: z.literal('list'),
  ordered: z.boolean().default(false),
  items: z.array(z.string()),
});

const KeyValueBlock = z.object({
  kind: z.literal('key_value'),
  entries: z.array(z.object({
    label: z.string(),
    value: Cell,
    emphasis: z.boolean().optional(),
  })),
});

const ComparisonTableBlock = z.object({
  kind: z.literal('comparison_table'),
  columns: z.array(z.string()),
  rows: z.array(z.record(Cell)),
  highlight: z.array(z.number()).optional(),
});

const ChecklistBlock = z.object({
  kind: z.literal('checklist'),
  items: z.array(z.object({
    text: z.string(),
    done: z.boolean().default(false),
    note: z.string().optional(),
  })),
});

const TimelineBlock = z.object({
  kind: z.literal('timeline'),
  events: z.array(z.object({
    time: z.string(),
    title: z.string(),
    detail: z.string().optional(),
    status: z.enum(['done','doing','todo']).optional(),
  })),
});

const DecisionBlock = z.object({
  kind: z.literal('decision'),
  question: z.string(),
  options: z.array(z.object({
    id: z.string(),
    label: z.string(),
    rationale: z.string().optional(),
    recommended: z.boolean().optional(),
  })),
  selectedOptionId: z.string().optional(),
});

const ActionRequestBlock = z.object({
  kind: z.literal('action_request'),
  intent: z.string(),
  capabilityId: z.string(),
  params: z.record(z.any()),
  needsApproval: z.boolean().default(true),
  sideEffectLevel: z.enum(['none','reversible','irreversible']),
  costEstimate: z.string().optional(),
  status: z.enum(['proposed','awaiting_user','approved','executed','rejected','failed']).default('proposed'),
  result: z.any().optional(),
});

const AttachmentBlock = z.object({
  kind: z.literal('attachment'),
  name: z.string(),
  url: z.string().url(),
  mime: z.string(),
  bytes: z.number().optional(),
});

const MediaBlock = z.object({
  kind: z.literal('media'),
  mediaType: z.enum(['image','video','audio']),
  url: z.string().url(),
  caption: z.string().optional(),
});

const CodeBlock = z.object({
  kind: z.literal('code'),
  language: z.string(),
  content: z.string(),
});

const ChartBlock = z.object({ kind: z.literal('chart'), spec: z.any() });

const EmbedBlock = z.object({
  kind: z.literal('embed'),
  provider: z.string(),
  url: z.string().url(),
});

const CalloutBlock = z.object({
  kind: z.literal('callout'),
  tone: z.enum(['info','warn','success','risk']),
  text: z.string(),
});

const ArtifactBlock = z.object({
  kind: z.literal('artifact'),
  artifactType: z.enum(['mermaid','vega-lite','markdown','html','react-jsx']),
  content: z.string(),
  permissions: z.object({
    allowScripts: z.boolean().default(false),
    allowNetwork: z.boolean().default(false),
    networkAllowlist: z.array(z.string()).optional(),
  }).default({ allowScripts: false, allowNetwork: false }),
  fallbackText: z.string(),
  events: z.array(z.object({ name: z.string(), schema: z.any() })).optional(),
});

export const ResultBlock = z.discriminatedUnion('kind', [
  HeadingBlock, ParagraphBlock, MarkdownBlock, ListBlock,
  KeyValueBlock, ComparisonTableBlock, ChecklistBlock, TimelineBlock,
  DecisionBlock, ActionRequestBlock,
  AttachmentBlock, MediaBlock, CodeBlock,
  ChartBlock, EmbedBlock, CalloutBlock, ArtifactBlock,
]);

export const TaskResult = z.object({
  schemaVersion: z.literal(1),
  taskId: z.string(),
  instanceId: z.string(),
  title: z.string(),
  blocks: z.array(ResultBlock),
  status: z.enum(['draft','pending_user','done','blocked','failed']),
  nextActions: z.array(ActionRequestBlock).optional(),
  meta: z.object({
    producedAt: z.string(),
    durationMs: z.number(),
    tokensUsed: z.number().optional(),
  }),
});

export type TaskResult = z.infer<typeof TaskResult>;
export type ResultBlock = z.infer<typeof ResultBlock>;
export type ActionRequestBlock = z.infer<typeof ActionRequestBlock>;
```

---

## 4. 给 Claude 注入 JSON Schema

新增 `src/lib/taskResult/schemaForPrompt.ts`：

```ts
import { zodToJsonSchema } from 'zod-to-json-schema';
import { TaskResult } from '@/types/taskResult';

export const TASK_RESULT_JSON_SCHEMA = zodToJsonSchema(TaskResult, 'TaskResult');

export const TASK_RESULT_PROMPT_FRAGMENT = `
你产出的最终结果必须是一个合法的 TaskResult JSON 对象，遵循下面的 JSON Schema。

约束：
1. 优先用最贴合信息形态的 block：
   - 比较多款方案 → comparison_table
   - 给用户做选择 → decision
   - 需要副作用动作 → action_request（必须声明 sideEffectLevel）
   - 流程图/架构图 → artifact + mermaid
2. 不要发明新的 block kind，未列出的形态用 paragraph 兜底。
3. 不要在最终输出外有任何额外文字，只输出 JSON。

TaskResult JSON Schema:
${JSON.stringify(TASK_RESULT_JSON_SCHEMA, null, 2)}
`.trim();
```

---

## 5. 解析与容错

新增 `src/lib/taskResult/parseAndRepair.ts`，复用现有多级 JSON 容错链 + ajv schema 校验：

```ts
import { TaskResult } from '@/types/taskResult';
import { tryParseJsonWithFallbacks } from '@/lib/server/jsonGuard';
import { runClaudeJsonRepair } from '@/lib/server/goalPlanning';

export async function parseTaskResult(raw: string): Promise<TaskResult> {
  const candidate = await tryParseJsonWithFallbacks(raw);
  const result = TaskResult.safeParse(candidate);
  if (result.success) return result.data;

  const repaired = await runClaudeJsonRepair(raw, {
    schemaErrors: result.error.issues,
    targetSchemaName: 'TaskResult',
  });
  return TaskResult.parse(repaired);
}
```

---

## 6. 渲染层

### 6.1 BlockRenderer

新增 `src/components/execution/BlockRenderer.tsx`：

```tsx
'use client';
import type { ResultBlock, TaskResult } from '@/types/taskResult';
import { HeadingBlock } from './blocks/HeadingBlock';
import { ParagraphBlock } from './blocks/ParagraphBlock';
import { ComparisonTableBlock } from './blocks/ComparisonTableBlock';
import { DecisionBlock } from './blocks/DecisionBlock';
import { ActionRequestBlock } from './blocks/ActionRequestBlock';
import { ArtifactSandbox } from './ArtifactSandbox';
import { FallbackBlock } from './blocks/FallbackBlock';

const BLOCK_COMPONENTS: Record<ResultBlock['kind'], React.FC<any>> = {
  heading: HeadingBlock,
  paragraph: ParagraphBlock,
  comparison_table: ComparisonTableBlock,
  decision: DecisionBlock,
  action_request: ActionRequestBlock,
  artifact: ArtifactSandbox,
  // 其余按需引入
};

export function BlockRenderer({ block, onAction }: {
  block: ResultBlock;
  onAction?: (action: { kind: string; payload: any }) => void;
}) {
  const Component = BLOCK_COMPONENTS[block.kind] ?? FallbackBlock;
  return <Component {...block} onAction={onAction} />;
}

export function TaskResultView({ result, variant = 'full', onAction }: {
  result: TaskResult;
  variant?: 'full' | 'card' | 'inbox';
  onAction?: (action: { kind: string; payload: any }) => void;
}) {
  if (variant === 'card') {
    const preview = result.blocks.find(b =>
      b.kind === 'paragraph' || b.kind === 'decision' || b.kind === 'callout'
    );
    return <div><h4>{result.title}</h4>{preview && <BlockRenderer block={preview} />}</div>;
  }
  if (variant === 'inbox') {
    const actions = result.nextActions ?? result.blocks.filter(b => b.kind === 'action_request');
    return <div><h4>{result.title}</h4>{actions.map((a, i) => <BlockRenderer key={i} block={a} onAction={onAction} />)}</div>;
  }
  return (
    <article>
      <h2>{result.title}</h2>
      {result.blocks.map((b, i) => <BlockRenderer key={i} block={b} onAction={onAction} />)}
    </article>
  );
}
```

`FallbackBlock` 把未知 kind 渲染为"label + 折叠 JSON"，永不白屏。

### 6.2 ArtifactSandbox

新增 `src/components/execution/ArtifactSandbox.tsx`，强沙箱 iframe：

```tsx
'use client';
import { useEffect, useRef } from 'react';
import type { z } from 'zod';
import { ResultBlock } from '@/types/taskResult';

type ArtifactProps = Extract<z.infer<typeof ResultBlock>, { kind: 'artifact' }> & {
  onAction?: (action: { kind: string; payload: any }) => void;
};

const BRIDGE_SCRIPT = `
<script>
  window.__kikiEmit = function(name, payload) {
    parent.postMessage({ __kiki: true, name, payload }, '*');
  };
</script>
`;

const STRICT_CSP = `default-src 'none'; style-src 'unsafe-inline'; img-src data:`;

function buildHtml(props: ArtifactProps): string {
  const { artifactType, content, permissions } = props;
  const csp = permissions.allowScripts
    ? STRICT_CSP + `; script-src 'unsafe-inline'`
    : STRICT_CSP;

  switch (artifactType) {
    case 'mermaid':
      return `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="${csp}; script-src 'unsafe-inline' https://cdn.jsdelivr.net">
</head><body>
<pre class="mermaid">${escapeHtml(content)}</pre>
<script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script>
<script>mermaid.initialize({startOnLoad:true});</script>
${BRIDGE_SCRIPT}
</body></html>`;
    case 'html':
    case 'react-jsx':
      return `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="${csp}">
</head><body>
${permissions.allowScripts ? content : escapeHtml(content)}
${BRIDGE_SCRIPT}
</body></html>`;
    case 'markdown':
      return `<pre>${escapeHtml(content)}</pre>`;
    default:
      return `<pre>${escapeHtml(props.fallbackText)}</pre>`;
  }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]!)
  );
}

export function ArtifactSandbox(props: ArtifactProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (!e.data?.__kiki) return;
      if (e.source !== iframeRef.current?.contentWindow) return;
      const allowed = props.events?.some(ev => ev.name === e.data.name);
      if (!allowed) return;
      props.onAction?.({ kind: e.data.name, payload: e.data.payload });
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [props.events, props.onAction]);

  return (
    <iframe
      ref={iframeRef}
      sandbox="allow-scripts"
      srcDoc={buildHtml(props)}
      className="w-full min-h-[200px] border rounded"
      title="artifact"
    />
  );
}
```

**关键安全约束**：

- iframe 只给 `allow-scripts`，不给 `allow-same-origin`，断绝对父页面的访问
- CSP 默认 `default-src 'none'`，按 `permissions` 显式放宽
- `postMessage` 事件必须命中 `events` 白名单才回灌
- 校验 `event.source === iframeRef.current.contentWindow`，防止跨 iframe 伪造

---

## 7. 接入点

### 7.1 执行后回写

`src/lib/server/goalTaskRunner.ts`：

```ts
import { parseTaskResult } from '@/lib/taskResult/parseAndRepair';

const result = await parseTaskResult(claudeRawOutput);
await runtimeJobsRepository.completeJob(jobId, {
  result,
  resultSchemaVersion: 1,
});
```

### 7.2 三处容器统一调用

```tsx
// 会话流卡片
<TaskResultView result={result} variant="card" />
// 任务详情抽屉
<TaskResultView result={result} variant="full" onAction={handleAction} />
// 收件箱卡片
<TaskResultView result={result} variant="inbox" onAction={handleAction} />
```

### 7.3 老组件降级为模板

`flashcard / draft_review / confirm_action` 不删除，改造为：当 BlockRenderer 检测到 blocks 序列符合特定模式（如"5 个 key_value + 1 个 decision"）时，自动选用专属模板渲染——这是渲染优化，非必需。

---

## 8. 落地步骤（建议 2 周）

| 周 | 任务 |
|---|---|
| 第 1 周 D1-D3 | 定义 `taskResult.ts` 全部 block 类型 + JSON Schema 自动生成脚本 |
| 第 1 周 D4-D5 | 实现 `BlockRenderer` + 至少 8 个核心 block 组件（heading / paragraph / list / key_value / comparison_table / decision / action_request / callout） |
| 第 2 周 D1-D2 | 改造 `goalTaskRunner.ts` 输出要求 + ajv 校验 + 容错链复用 |
| 第 2 周 D3 | `ArtifactSandbox` 实现 + mermaid/vega 两种 artifactType |
| 第 2 周 D4 | 三个老组件重构为模板特征匹配 |
| 第 2 周 D5 | 端到端联调：跑通"调研 SUV 车型"任务，产出 `comparison_table + decision` |

---

## 9. 验收标准

- ✅ 任意已有任务执行后，渲染走 BlockRenderer，无报错、无白屏
- ✅ `expectedOutputSketch` 出现在目标规划抽屉的任务条目下
- ✅ Artifact 沙箱用 mermaid 渲染流程图，`postMessage` 事件能回到 store
- ✅ 未知 block kind 自动降级到 FallbackBlock，不阻塞主流程
- ✅ 同一份 `TaskResult` 在会话卡片/抽屉/收件箱三个容器渲染都正确

---

## 10. 风险与对策

| 风险 | 对策 |
|---|---|
| Block 原语集表达力不足 | 先 17 种灰度，按真实场景缺口加；artifact 是逃生舱 |
| Agent 选错 block（该 table 用了 paragraph） | system prompt 给 few-shot；执行后自检一次 |
| Artifact 安全配置错误 | iframe 永不给 `allow-same-origin`；CSP `default-src 'none'` |
| 老用户存量 result 不兼容 | `schemaVersion` 字段做迁移；旧数据按 raw_text 渲染 |
| zod 体积大 | 客户端 bundle 用 `zod/v4-mini` 或仅做类型导出 |

---

## 11. 不在本方案范围

- 副作用动作的真实执行（→ 方案 2）
- 能力缺口检测与自造（→ 方案 3）
- 任务调度策略（继续用现有 Scheduler）

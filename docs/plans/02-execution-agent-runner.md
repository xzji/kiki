# 方案 2：执行层 — Capability + Plan-Act-Reflect

> 目标：把任务执行从**单轮 prompt → 多轮工具调用循环**；引入**副作用闸门**让不可逆动作必须经用户审批；短期不建大 Registry，**先用拦截器包住 Claude Code 内置工具**，长期演进为 Capability 中台。

---

## 1. 设计动机

KiKi 现在的 `goalTaskRunner` 是 fire-and-forget 单轮执行：把任务 prompt 给 Claude → 拿一段输出 → 写回结果。这种模型只能"说事"，不能"做事"。但买 SUV 要真的查询 4S 店、约试驾、打电话；做 iOS App 要真的写代码、跑构建、提交审核。

要支持"做事"，执行层必须升级为 **ReAct / Tool-Use 循环**：Agent 看任务 → 选工具 → 调用 → 拿结果 → 反思 → 再选工具，直到完成或阻塞。

同时引入 **Capability 抽象**——但**不是替代** Claude Code 内置工具，而是**补齐它没有的能力**（通信、支付、第三方集成）+ 为所有工具调用统一**副作用守门人**和**产品化可观测性**。

| 能力类型 | Claude Code 内置 | 本方案补齐 |
|---|---|---|
| 文件 / 代码 / Shell / Web | ✅ | 直接复用 |
| 浏览器自动化、邮件、电话、日历、支付、第三方集成 | ❌ | 通过 Capability Registry 接入 |
| 副作用分级 + 审批闸门 | ❌（仅 allow/deny） | 本方案核心价值 |
| 产品化动作可观测性（trajectory + UI） | ❌ | 本方案核心价值 |
| 多执行后端切换（Claude / Cursor / Codex） | ❌ | 通过统一抽象 |

---

## 2. 与现有模块的关系

| 现有 | 改造方式 |
|---|---|
| `src/lib/server/goalTaskRunner.ts`（fire-and-forget 单轮） | 替换/包装为 plan-act-reflect 循环 driver |
| Claude CLI 调用（`claudeEnv.ts` 等） | 启用 stream-json 输出 + tool_use 事件解析 |
| `runtime_jobs` 表 | 新增 `trajectory` JSONB 列存 step 序列 |
| `inboxStore.ts` | 新增 `pending_approval` 卡片类型，承接审批 |
| `easterEggSettingsStore.ts` | 新增 `maxIterations / approvalPolicy / sideEffectStrictness` |
| 方案 1 的 `TaskResult` | 作为本方案的最终产出契约 |

---

## 3. 数据模型

### 3.1 TaskExecution & ExecutionStep

新增 `src/types/execution.ts`：

```ts
import { z } from 'zod';
import { ResultBlock, TaskResult } from './taskResult';

export const ExecutionStep = z.object({
  index: z.number(),
  thought: z.string().optional(),
  toolCall: z.object({
    name: z.string(),
    input: z.any(),
  }).optional(),
  toolResult: z.object({
    ok: z.boolean(),
    output: z.any().optional(),
    error: z.string().optional(),
  }).optional(),
  approvalGate: z.object({
    state: z.enum(['requested','approved','rejected']),
    requestedAt: z.string(),
    decidedAt: z.string().optional(),
    decidedBy: z.string().optional(),
  }).optional(),
  emittedBlocks: z.array(ResultBlock).optional(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
});

export const TaskExecution = z.object({
  id: z.string(),
  taskId: z.string(),
  instanceId: z.string(),
  status: z.enum(['running','blocked_on_user','dormant','done','failed']),
  steps: z.array(ExecutionStep),
  result: TaskResult.optional(),
  blockedReason: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ExecutionStep = z.infer<typeof ExecutionStep>;
export type TaskExecution = z.infer<typeof TaskExecution>;
```

**三类终止条件**：`done` / `blocked_on_user`（等审批或等用户输入）/ `failed`。
**`blocked_on_user` 是常态而非异常**——长程目标的本质就是会反复回到用户。

### 3.2 Capability 契约

新增 `src/lib/capabilities/types.ts`：

```ts
import { z } from 'zod';

export type SideEffect = 'none' | 'reversible' | 'irreversible';

export interface CapabilityContext {
  userId: string;
  workspaceRoot: string;
  executionId: string;
  credentials: CredentialAccessor;
  logger: (msg: string, data?: any) => void;
}

export interface CredentialAccessor {
  get(scope: string): Promise<string | null>;
}

export interface Capability<I = any, O = any> {
  id: string;                         // 'web.search' | 'email.send' ...
  source: 'builtin' | 'imported' | 'forged';
  sideEffect: SideEffect;
  description: string;                // 给 Claude 看
  inputSchema: z.ZodType<I>;
  outputSchema: z.ZodType<O>;
  invoke: (input: I, ctx: CapabilityContext) => Promise<O>;
  dryRun?: (input: I, ctx: CapabilityContext) => Promise<O>;
  describeForUser: (input: I) => { title: string; detail: string };
}
```

---

## 4. Capability Registry

新增 `src/lib/capabilities/registry.ts`：

```ts
import type { Capability } from './types';

class CapabilityRegistry {
  private items = new Map<string, Capability>();

  register(cap: Capability) {
    if (this.items.has(cap.id)) throw new Error(`Capability ${cap.id} already registered`);
    this.items.set(cap.id, cap);
  }

  get(id: string): Capability | undefined { return this.items.get(id); }

  list(filter?: { source?: 'builtin'|'imported'|'forged' }): Capability[] {
    return [...this.items.values()].filter(c =>
      !filter?.source || c.source === filter.source
    );
  }

  describeAll(): string {
    return this.list().map(c =>
      `- ${c.id} (${c.sideEffect}): ${c.description}`
    ).join('\n');
  }
}

export const capabilityRegistry = new CapabilityRegistry();
```

---

## 5. 副作用拦截器（短期低成本版）

不立刻为所有 Claude Code 内置工具建 Capability，而是先做一个**拦截中间件**——`agentRunner` 解析到 tool_use 时调用它判定。

新增 `src/lib/capabilities/sideEffectGuard.ts`：

```ts
import type { SideEffect } from './types';

interface Rule {
  match: (toolName: string, input: any) => boolean;
  level: SideEffect;
  reason: string;
}

const RULES: Rule[] = [
  // 内置 - 安全
  { match: n => ['Read','Glob','Grep','WebFetch','WebSearch'].includes(n),
    level: 'none', reason: '只读' },

  // 文件写在 workspace 内 - 可逆
  { match: (n, i) => ['Write','Edit'].includes(n) && isInsideWorkspace(i?.file_path),
    level: 'reversible', reason: '工作目录内写入' },

  // Bash 危险模式 - 不可逆
  { match: (n, i) => n === 'Bash' && /\b(rm\s+-rf|dd\s|mkfs|shutdown)\b/.test(i?.command ?? ''),
    level: 'irreversible', reason: '破坏性命令' },
  { match: (n, i) => n === 'Bash' && /\bcurl\s+(-X\s+)?(POST|PUT|DELETE)/i.test(i?.command ?? ''),
    level: 'irreversible', reason: '可能修改远程资源' },
  { match: (n, i) => n === 'Bash' && /\bgit\s+push\b/.test(i?.command ?? ''),
    level: 'irreversible', reason: '推送到远端' },

  { match: n => n === 'Bash', level: 'reversible', reason: '本地命令' },
];

function isInsideWorkspace(p?: string): boolean {
  if (!p) return false;
  return !p.startsWith('/etc') && !p.startsWith('/usr') && !p.includes('..');
}

export function classifySideEffect(toolName: string, input: any): {
  level: SideEffect;
  reason: string;
} {
  for (const rule of RULES) {
    if (rule.match(toolName, input)) return { level: rule.level, reason: rule.reason };
  }
  return { level: 'irreversible', reason: '未知工具，默认拦截' };
}
```

等加第一个非内置 capability（如 email）时，再为它显式注册到 Registry。

---

## 6. Plan-Act-Reflect 主循环

新增 `src/lib/server/agentRunner.ts`：

```ts
import { spawnClaudeStream } from './claudeStream';
import { capabilityRegistry } from '@/lib/capabilities/registry';
import { classifySideEffect } from '@/lib/capabilities/sideEffectGuard';
import { runtimeJobsRepository } from './repositories/runtimeJobsRepository';
import { inboxRepository } from './repositories/inboxRepository';
import { parseTaskResult } from '@/lib/taskResult/parseAndRepair';
import { TASK_RESULT_PROMPT_FRAGMENT } from '@/lib/taskResult/schemaForPrompt';
import type { TaskExecution, ExecutionStep } from '@/types/execution';

const MAX_ITERATIONS = 30;

export async function runAgent(opts: {
  executionId: string;
  taskId: string;
  instanceId: string;
  taskBrief: string;
  expectedOutputSketch: string;
  resumeFrom?: TaskExecution;
}): Promise<TaskExecution> {
  let exec: TaskExecution = opts.resumeFrom ?? {
    id: opts.executionId,
    taskId: opts.taskId,
    instanceId: opts.instanceId,
    status: 'running',
    steps: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const systemPrompt = buildSystemPrompt(opts.taskBrief, opts.expectedOutputSketch);

  while (exec.status === 'running' && exec.steps.length < MAX_ITERATIONS) {
    const step: ExecutionStep = {
      index: exec.steps.length,
      startedAt: new Date().toISOString(),
    };

    const stream = spawnClaudeStream({
      systemPrompt,
      messages: stepsToMessages(exec.steps),
      tools: capabilitiesToToolDescriptors(),
      sessionId: exec.id,
    });

    let accumulatedText = '';
    let toolUseEvent: { name: string; input: any } | null = null;
    let stopReason = '';

    for await (const event of stream) {
      if (event.type === 'text_delta') accumulatedText += event.delta;
      if (event.type === 'tool_use') { toolUseEvent = event; break; }
      if (event.type === 'stop') { stopReason = event.reason; break; }
    }

    step.thought = accumulatedText.trim() || undefined;

    if (toolUseEvent) {
      step.toolCall = toolUseEvent;
      const { level, reason } = classifySideEffect(toolUseEvent.name, toolUseEvent.input);

      if (level === 'irreversible') {
        // 暂停，写收件箱审批卡
        step.approvalGate = { state: 'requested', requestedAt: new Date().toISOString() };
        await inboxRepository.create({
          type: 'execution_approval',
          executionId: exec.id,
          stepIndex: step.index,
          payload: { toolCall: toolUseEvent, sideEffectReason: reason },
        });
        exec.status = 'blocked_on_user';
        exec.blockedReason = `等待用户审批：${toolUseEvent.name}`;
      } else {
        const cap = capabilityRegistry.get(toolUseEvent.name);
        try {
          const output = cap
            ? await cap.invoke(toolUseEvent.input, buildContext(exec))
            : await invokeClaudeCodeBuiltin(toolUseEvent);
          step.toolResult = { ok: true, output };
        } catch (err: any) {
          step.toolResult = { ok: false, error: err.message };
        }
      }
    } else if (stopReason === 'end_turn' && accumulatedText.includes('"schemaVersion"')) {
      try {
        const result = await parseTaskResult(accumulatedText);
        exec.result = result;
        exec.status = 'done';
      } catch (err: any) {
        exec.status = 'failed';
        exec.blockedReason = `结果解析失败：${err.message}`;
      }
    } else {
      exec.status = 'failed';
      exec.blockedReason = '模型未输出可识别结果';
    }

    step.endedAt = new Date().toISOString();
    exec.steps.push(step);
    exec.updatedAt = new Date().toISOString();
    await runtimeJobsRepository.persistExecution(exec);
  }

  if (exec.steps.length >= MAX_ITERATIONS && exec.status === 'running') {
    exec.status = 'failed';
    exec.blockedReason = '超过最大迭代次数';
    await runtimeJobsRepository.persistExecution(exec);
  }

  return exec;
}
```

### 6.1 审批后恢复

```ts
export async function resumeAgent(executionId: string, approval: {
  approved: boolean;
  modifiedInput?: any;
  decidedBy: string;
}): Promise<TaskExecution> {
  const exec = await runtimeJobsRepository.loadExecution(executionId);
  const lastStep = exec.steps[exec.steps.length - 1];
  if (!lastStep.approvalGate) throw new Error('没有等待审批的 step');

  lastStep.approvalGate.state = approval.approved ? 'approved' : 'rejected';
  lastStep.approvalGate.decidedAt = new Date().toISOString();
  lastStep.approvalGate.decidedBy = approval.decidedBy;

  if (!approval.approved) {
    exec.status = 'failed';
    exec.blockedReason = '用户拒绝执行';
    await runtimeJobsRepository.persistExecution(exec);
    return exec;
  }

  const input = approval.modifiedInput ?? lastStep.toolCall!.input;
  const cap = capabilityRegistry.get(lastStep.toolCall!.name);
  try {
    const output = cap
      ? await cap.invoke(input, buildContext(exec))
      : await invokeClaudeCodeBuiltin({ ...lastStep.toolCall!, input });
    lastStep.toolResult = { ok: true, output };
  } catch (err: any) {
    lastStep.toolResult = { ok: false, error: err.message };
  }
  exec.status = 'running';
  exec.blockedReason = undefined;
  await runtimeJobsRepository.persistExecution(exec);

  return runAgent({
    executionId: exec.id,
    taskId: exec.taskId,
    instanceId: exec.instanceId,
    taskBrief: '',
    expectedOutputSketch: '',
    resumeFrom: exec,
  });
}
```

---

## 7. Claude CLI Stream-JSON 接入

新增 `src/lib/server/claudeStream.ts`：

```ts
import { spawn } from 'node:child_process';
import { buildCleanEnv } from './claudeEnv';

export type ClaudeStreamEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_use'; name: string; input: any }
  | { type: 'stop'; reason: string };

export async function* spawnClaudeStream(opts: {
  systemPrompt: string;
  messages: any[];
  tools: any[];
  sessionId: string;
}): AsyncGenerator<ClaudeStreamEvent> {
  const args = ['--output-format', 'stream-json', '--resume', opts.sessionId];
  const child = spawn('claude', args, {
    env: buildCleanEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.write(JSON.stringify({
    system: opts.systemPrompt,
    messages: opts.messages,
    tools: opts.tools,
  }));
  child.stdin.end();

  let buffer = '';
  for await (const chunk of child.stdout) {
    buffer += chunk.toString();
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      yield mapClaudeEvent(event);
    }
  }
}

function mapClaudeEvent(e: any): ClaudeStreamEvent {
  if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta')
    return { type: 'text_delta', delta: e.delta.text };
  if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use')
    return { type: 'tool_use', name: e.content_block.name, input: e.content_block.input };
  if (e.type === 'message_stop')
    return { type: 'stop', reason: e.stop_reason ?? 'end_turn' };
  return { type: 'text_delta', delta: '' };
}
```

---

## 8. 审批 UI

新增 `src/components/execution/ApprovalCard.tsx`：

```tsx
'use client';
import { useState } from 'react';

interface Props {
  executionId: string;
  stepIndex: number;
  toolCall: { name: string; input: any };
  sideEffectReason: string;
  describeForUser: { title: string; detail: string };
}

export function ApprovalCard(p: Props) {
  const [editingInput, setEditingInput] = useState(p.toolCall.input);
  const [pending, setPending] = useState(false);

  async function decide(approved: boolean) {
    setPending(true);
    await fetch('/api/agent/approve', {
      method: 'POST',
      body: JSON.stringify({
        executionId: p.executionId,
        approved,
        modifiedInput: approved ? editingInput : undefined,
      }),
    });
    setPending(false);
  }

  return (
    <div className="border rounded p-4">
      <h4>需要你的批准：{p.describeForUser.title}</h4>
      <p className="text-sm">{p.describeForUser.detail}</p>
      <details>
        <summary>调用参数</summary>
        <textarea
          value={JSON.stringify(editingInput, null, 2)}
          onChange={e => setEditingInput(JSON.parse(e.target.value))}
          rows={6}
          className="w-full font-mono text-xs"
        />
      </details>
      <p className="text-xs text-gray-500">风险：{p.sideEffectReason}</p>
      <div className="flex gap-2 mt-2">
        <button disabled={pending} onClick={() => decide(true)}>批准并执行</button>
        <button disabled={pending} onClick={() => decide(false)}>拒绝</button>
      </div>
    </div>
  );
}
```

---

## 9. 数据库迁移

`src/lib/server/db/migrations/0002_executions.sql`：

```sql
ALTER TABLE runtime_jobs ADD COLUMN trajectory TEXT;
ALTER TABLE runtime_jobs ADD COLUMN execution_status TEXT;
CREATE INDEX idx_runtime_jobs_status ON runtime_jobs(execution_status);

CREATE TABLE IF NOT EXISTS inbox_items (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unread',
  execution_id TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
```

---

## 10. 长程任务的两个进阶状态

为后续支持"买 SUV 这类跨周/跨月目标"埋好接口：

| 状态 | 触发场景 | 实现 |
|---|---|---|
| `dormant` | 任务挂起等待外部事件（一周后再继续） | 加 `wakeTriggers: { time?, event? }` 字段，由 Scheduler 按时唤醒 |
| Sub-Agent 派生 | iOS App 这类需几十小时的长任务 | Capability 调用 `shell.run_in_workspace` 启动 Claude Code 子进程，主 Agent 定期 check 进度 |

本方案先把核心循环和审批闸跑通，dormant + Sub-Agent 在第二期补。

---

## 11. 落地步骤（建议 3 周）

| 周 | 任务 |
|---|---|
| 第 1 周 | `TaskExecution` 类型 + `runtime_jobs` schema 迁移 + `agentRunner` 单工具循环骨架（仅 web.search/web.fetch） |
| 第 2 周 | Claude CLI stream-json 解析 + tool_use 多轮循环 + 中断恢复 |
| 第 2 周 | `sideEffectGuard` 拦截器 + ApprovalCard UI + 收件箱审批闭环 |
| 第 3 周 | 任务详情抽屉接 trajectory 可视化（每一步 thought + toolCall + result）|
| 第 3 周 | 端到端：跑通"调研 SUV 车型"——多轮 web.fetch → 产出 comparison_table |
| 第 3 周 | 第一个非内置 capability 试点：邮件（接 SMTP/Gmail SDK），走完整审批闸 |

---

## 12. 验收标准

- ✅ 一个任务执行可包含 ≥3 步工具调用，trajectory 完整可查
- ✅ irreversible 调用必触发审批，用户拒绝后任务状态正确
- ✅ 用户关闭浏览器再打开，`blocked_on_user` 状态不丢，审批后能恢复
- ✅ 现有 fire-and-forget 路径不破坏（feature flag 切换）
- ✅ 第一个非内置 capability（邮件）可以跑通完整链路

---

## 13. 风险与对策

| 风险 | 对策 |
|---|---|
| 循环死锁（Agent 反复试同一工具） | `MAX_ITERATIONS` 兜底 + 检测连续失败 ≥3 次降级 |
| 工具调用费时长 | 单步超时 + 任务级超时 + watchdog 暂停 |
| 拦截规则误判（把安全的判为危险） | 规则列表配置化，用户可在设置里调整严格度 |
| Claude CLI stream 解析格式漂移 | mapper 用宽松匹配 + 未知事件不致命 |
| 审批卡片堆积导致用户疲劳 | 同类型动作一次性批量审批；学习用户偏好做"信任名单" |
| 跨容器 / 跨设备运行同步 | trajectory 写 SQLite，daemon/前端共享视图 |

---

## 14. 不在本方案范围

- block JSON 渲染（→ 方案 1）
- 缺失能力的自我锻造（→ 方案 3）
- 真正的金融级支付/医疗级动作（需要更严格审计，二期单独立项）

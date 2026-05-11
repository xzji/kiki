# 方案 3：进化层 — Capability Forge（能力锻造）

> 目标：当 Agent 在执行任务时**遇到平台没预建的能力**（发邮件、查股价、操作小众 SaaS）时，让它**自己造一个 Skill 包**，经过测试 + 沙箱试运行 + 用户审批后落到 `~/.claude/skills/` 永久注册，未来其他任务自动复用。

---

## 1. 设计动机

方案 2 的 Capability Registry 是**有限集合**——产品团队预建的 + 接入的官方 SDK。但用户的长程目标是**长尾的**：

- 买 SUV 时需要"查某个垂直车评网站某指标"
- 装修时需要"调用某城市某物业 API"
- 做研究时需要"操作某个小众学术数据库"

不可能预建所有。最自然的解法是 **"Self-Improving Agent"**——Agent 遇到缺口时自己造工具，造出来沉淀下来未来复用。这是 Voyager / ToolMaker / CREATOR 等论文的方向，工业界已有先例。

但**自我修改型系统有典型失败模式**：偷懒乱造、能力爆炸、prompt injection 触发恶意造工具、凭证管理失控、质量参差……必须配套**搜索-锻造-验证-审批-注册**五阶段流程和 trustLevel 治理。

---

## 2. 关键设计原则

1. **不发明新机制**：产物是标准 Skill / MCP server 格式，落到 `~/.claude/skills/`，下次启动 Claude 自动加载
2. **先 search 再 forge**：避免重复造轮子（本地 registry → MCP 公共 registry → 才考虑造）
3. **三道闸**：自动测试 + 沙箱试运行 + 静态扫描，**首次必须人工审批**
4. **trustLevel 分级**：experimental → verified → builtin（被产品团队收编重写）
5. **凭证隔离**：经平台凭证服务，不允许硬编码或跨能力访问

---

## 3. 与现有模块的关系

| 现有 / 前置方案 | 改造方式 |
|---|---|
| 方案 2 的 `agentRunner` | 在每个 step 后加 `detectGap()` 钩子 |
| 方案 2 的 Capability Registry | 新增 `forged` source 类型 + `trustLevel` 字段 |
| `~/.claude/skills/` | 作为 forged capability 的物理落盘位置 |
| `inboxStore` | 新增 `forge_approval` 卡片类型 |
| `data/kiki.db` | 新增 `capability_gaps`、`forged_capabilities` 表 |

---

## 4. 数据模型

新增 `src/lib/capabilities/forge/types.ts`：

```ts
import { z } from 'zod';

export const CapabilityGap = z.object({
  id: z.string(),
  intent: z.string(),
  expectedInputs: z.array(z.string()),
  expectedOutputs: z.array(z.string()),
  blockingExecutionId: z.string(),
  detectedAt: z.string(),
  status: z.enum(['detected','searching','forging','verifying','approved','rejected','failed']),
});

export const CapabilityManifest = z.object({
  id: z.string(),
  version: z.string(),
  description: z.string(),
  sideEffect: z.enum(['none','reversible','irreversible']),
  credentials: z.array(z.object({
    name: z.string(),
    scope: z.string(),
    required: z.boolean(),
  })),
  network: z.object({ allowlist: z.array(z.string()) }).optional(),
  inputSchema: z.any(),
  outputSchema: z.any(),
});

export const ForgedCapability = z.object({
  id: z.string(),
  gapId: z.string(),
  trustLevel: z.enum(['experimental','verified','quarantined']),
  manifest: CapabilityManifest,
  filesPath: z.string(),
  approvedBy: z.string().optional(),
  approvedAt: z.string().optional(),
  usageStats: z.object({
    calls: z.number().default(0),
    failures: z.number().default(0),
    lastUsedAt: z.string().optional(),
  }),
});

export type CapabilityGap = z.infer<typeof CapabilityGap>;
export type CapabilityManifest = z.infer<typeof CapabilityManifest>;
export type ForgedCapability = z.infer<typeof ForgedCapability>;
```

---

## 5. 五阶段流程

```
[Detect] → [Search] → [Forge] → [Verify] → [Approve] → [Register]
   ↑          ↓ 命中复用       ↓ 测试失败       ↓ 用户拒绝
   缺口信号    跳过 forge      标记 failed      标记 rejected
```

### 5.1 Detect（缺口检测）

`src/lib/capabilities/forge/detector.ts`：

```ts
import type { ExecutionStep, TaskExecution } from '@/types/execution';
import { capabilityRegistry } from '../registry';
import type { CapabilityGap } from './types';
import { v4 as uuid } from 'uuid';

const GAP_SIGNAL_RE = /CAPABILITY_GAP:\s*(\{[\s\S]*?\})/;

export function detectGapInStep(step: ExecutionStep, exec: TaskExecution): CapabilityGap | null {
  // 信号 1：Claude 显式声明
  const m = step.thought?.match(GAP_SIGNAL_RE);
  if (m) {
    try {
      const parsed = JSON.parse(m[1]);
      return {
        id: uuid(),
        intent: parsed.intent,
        expectedInputs: parsed.expectedInputs ?? [],
        expectedOutputs: parsed.expectedOutputs ?? [],
        blockingExecutionId: exec.id,
        detectedAt: new Date().toISOString(),
        status: 'detected',
      };
    } catch { /* ignore */ }
  }

  // 信号 2：toolCall 指向不存在的能力
  if (step.toolCall && !capabilityRegistry.get(step.toolCall.name)) {
    return {
      id: uuid(),
      intent: `调用未知工具 ${step.toolCall.name}`,
      expectedInputs: Object.keys(step.toolCall.input ?? {}),
      expectedOutputs: [],
      blockingExecutionId: exec.id,
      detectedAt: new Date().toISOString(),
      status: 'detected',
    };
  }

  return null;
}
```

在 `agentRunner` 的循环里，每完成一步调一次 `detectGapInStep(step, exec)`，命中则跳出主循环走锻造流程。

### 5.2 Search（先查再造）

`src/lib/capabilities/forge/searcher.ts`：

```ts
import { capabilityRegistry } from '../registry';
import type { CapabilityGap } from './types';

export interface SearchResult {
  match: 'exact' | 'similar' | 'mcp_available' | 'none';
  capabilityId?: string;
  mcpServer?: { name: string; installCommand: string };
  similarity?: number;
}

export async function searchCapability(gap: CapabilityGap): Promise<SearchResult> {
  // 1. 本地 registry 精确/相似匹配
  const local = capabilityRegistry.list();
  for (const c of local) {
    if (c.description.toLowerCase().includes(gap.intent.toLowerCase()))
      return { match: 'exact', capabilityId: c.id };
  }

  // 2. embedding 相似度
  const sim = await embeddingSimilarity(gap.intent, local.map(c => c.description));
  const best = sim.findIndex(s => s > 0.85);
  if (best >= 0)
    return { match: 'similar', capabilityId: local[best].id, similarity: sim[best] };

  // 3. MCP 公共 registry
  const mcp = await queryMcpRegistry(gap.intent);
  if (mcp) return { match: 'mcp_available', mcpServer: mcp };

  return { match: 'none' };
}

async function embeddingSimilarity(q: string, candidates: string[]): Promise<number[]> {
  // TODO: 接 embedding 服务
  return candidates.map(() => 0);
}

async function queryMcpRegistry(intent: string) {
  // TODO: 接 modelcontextprotocol.io
  return null;
}
```

**关键**：search 阶段必须严格——Agent 最容易犯的错就是不查就造。

### 5.3 Forge（锻造子 Agent）

`src/lib/capabilities/forge/forger.ts`：

```ts
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawnClaudeStream } from '@/lib/server/claudeStream';
import type { CapabilityGap } from './types';

const FORGE_ROOT = process.env.HOME + '/.kiki/forge';

const FORGE_SYSTEM_PROMPT = `
你是 KiKi 能力锻造子 Agent。任务是为给定能力缺口产出一个标准 Skill 包。

硬约束：
1. 必须按目录结构产出，缺一不可：
   SKILL.md / manifest.json / src/handler.ts / src/schema.json /
   tests/smoke.test.ts / tests/dry_run.test.ts / README.md
2. handler.ts 导出 invoke(input, ctx) 和可选 dryRun(input, ctx)
3. manifest.json 必须声明 sideEffect / credentials / network.allowlist
4. 不允许硬编码任何凭证；通过 ctx.credentials.get(scope) 读取
5. dryRun 必须用 mock 不联网，返回符合 outputSchema 的真值
6. 测试必须可独立运行：node tests/smoke.test.ts 退出码 0
7. 完成后输出 JSON：{"status":"forged","manifestPath":"..."}
`.trim();

export async function forgeCapability(gap: CapabilityGap): Promise<{
  workdir: string;
  manifestPath: string;
}> {
  const workdir = path.join(FORGE_ROOT, gap.id);
  await fs.mkdir(workdir, { recursive: true });

  const stream = spawnClaudeStream({
    systemPrompt: FORGE_SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: JSON.stringify({
        intent: gap.intent,
        expectedInputs: gap.expectedInputs,
        expectedOutputs: gap.expectedOutputs,
        workdir,
      })}],
    }],
    tools: forgeAllowedTools(workdir),
    sessionId: `forge-${gap.id}`,
  });

  for await (const _ of stream) { /* 处理 tool_use 在 workdir 限定下执行 */ }

  return { workdir, manifestPath: path.join(workdir, 'manifest.json') };
}

function forgeAllowedTools(workdir: string) {
  // 限定文件操作只能在 workdir 内
  return [
    { name: 'fs.write', description: '写文件（限 workdir）', input_schema: { /* ... */ } },
    { name: 'shell.exec', description: '只能跑 npm install / node tests/*', input_schema: { /* ... */ } },
  ];
}
```

**锻造产物目录结构**：

```
~/.kiki/forge/<gap_id>/
  SKILL.md              # 描述、触发条件、参数、安全等级
  manifest.json         # 平台元数据
  src/
    handler.ts          # 实际执行逻辑
    schema.json         # 输入输出 JSON Schema
  tests/
    smoke.test.ts       # 基本可用性
    dry_run.test.ts     # mock 演练
  README.md
  CHANGELOG.md
```

### 5.4 Verify（三道闸）

`src/lib/capabilities/forge/verifier.ts`：

```ts
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CapabilityManifest } from './types';

export interface VerificationReport {
  passed: boolean;
  smokeTest: { passed: boolean; output: string };
  dryRunTest: { passed: boolean; output: string };
  staticScan: { passed: boolean; findings: string[] };
  depsAudit: { passed: boolean; vulns: number };
  manifest: CapabilityManifest;
}

export async function verify(workdir: string): Promise<VerificationReport> {
  const manifestRaw = await fs.readFile(path.join(workdir, 'manifest.json'), 'utf-8');
  const manifest = CapabilityManifest.parse(JSON.parse(manifestRaw));

  const smoke = await runTest(workdir, 'tests/smoke.test.ts');
  const dryRun = await runTest(workdir, 'tests/dry_run.test.ts');
  const scan = await staticScan(workdir);
  const audit = await depsAudit(workdir);

  return {
    passed: smoke.passed && dryRun.passed && scan.passed && audit.passed,
    smokeTest: smoke,
    dryRunTest: dryRun,
    staticScan: scan,
    depsAudit: audit,
    manifest,
  };
}

async function runTest(workdir: string, testFile: string) {
  return new Promise<{ passed: boolean; output: string }>((resolve) => {
    const child = spawn('node', ['--experimental-strip-types', testFile], {
      cwd: workdir,
      env: { ...process.env, KIKI_DRY_RUN: '1' },
      timeout: 30_000,
    });
    let out = '';
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => out += d);
    child.on('close', code => resolve({ passed: code === 0, output: out }));
  });
}

async function staticScan(workdir: string) {
  const findings: string[] = [];
  const files = await listAllFiles(workdir);
  for (const f of files) {
    if (!f.endsWith('.ts') && !f.endsWith('.js')) continue;
    const c = await fs.readFile(f, 'utf-8');
    if (/process\.env\.(?!KIKI_)/.test(c) && !c.includes('// allowed-env'))
      findings.push(`${f}: 直接读 env`);
    if (/\bexec\(|child_process/.test(c)) findings.push(`${f}: 子进程调用`);
    if (/eval\(|new Function\(/.test(c)) findings.push(`${f}: 动态代码执行`);
    if (/\.\.\//.test(c) && /readFile|writeFile/.test(c))
      findings.push(`${f}: 路径穿越嫌疑`);
  }
  return { passed: findings.length === 0, findings };
}

async function depsAudit(workdir: string) {
  return new Promise<{ passed: boolean; vulns: number }>((resolve) => {
    const child = spawn('npm', ['audit', '--json'], { cwd: workdir });
    let out = '';
    child.stdout.on('data', d => out += d);
    child.on('close', () => {
      try {
        const j = JSON.parse(out);
        const vulns = j.metadata?.vulnerabilities?.high ?? 0;
        resolve({ passed: vulns === 0, vulns });
      } catch { resolve({ passed: true, vulns: 0 }); }
    });
  });
}

async function listAllFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await listAllFiles(p));
    else out.push(p);
  }
  return out;
}
```

**生产建议**：静态扫描接 `semgrep`，沙箱试运行用 `firejail` / `seccomp` 限制系统调用。

### 5.5 Approve & Register

`src/lib/capabilities/forge/installer.ts`：

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { capabilityRegistry } from '../registry';
import type { CapabilityManifest, ForgedCapability } from './types';
import { forgedCapabilitiesRepository } from '@/lib/server/repositories/forgedCapabilitiesRepository';

const SKILLS_ROOT = process.env.HOME + '/.claude/skills';

export async function install(opts: {
  gapId: string;
  workdir: string;
  manifest: CapabilityManifest;
  approvedBy: string;
}): Promise<ForgedCapability> {
  const targetDir = path.join(SKILLS_ROOT, opts.manifest.id);
  await fs.mkdir(SKILLS_ROOT, { recursive: true });
  await copyDir(opts.workdir, targetDir);

  const forged: ForgedCapability = {
    id: opts.manifest.id,
    gapId: opts.gapId,
    trustLevel: 'experimental',
    manifest: opts.manifest,
    filesPath: targetDir,
    approvedBy: opts.approvedBy,
    approvedAt: new Date().toISOString(),
    usageStats: { calls: 0, failures: 0 },
  };
  await forgedCapabilitiesRepository.save(forged);

  const handler = await import(path.join(targetDir, 'src/handler.ts'));
  capabilityRegistry.register({
    id: opts.manifest.id,
    source: 'forged',
    sideEffect: opts.manifest.sideEffect,
    description: opts.manifest.description,
    inputSchema: opts.manifest.inputSchema,
    outputSchema: opts.manifest.outputSchema,
    invoke: handler.invoke,
    dryRun: handler.dryRun,
    describeForUser: handler.describeForUser ??
      ((i) => ({ title: opts.manifest.description, detail: JSON.stringify(i) })),
  });

  return forged;
}

async function copyDir(src: string, dst: string) {
  await fs.mkdir(dst, { recursive: true });
  for (const e of await fs.readdir(src, { withFileTypes: true })) {
    const a = path.join(src, e.name), b = path.join(dst, e.name);
    if (e.isDirectory()) await copyDir(a, b);
    else await fs.copyFile(a, b);
  }
}
```

### 5.6 Orchestrator 串起五阶段

`src/lib/capabilities/forge/orchestrator.ts`：

```ts
import { searchCapability } from './searcher';
import { forgeCapability } from './forger';
import { verify } from './verifier';
import { install } from './installer';
import { inboxRepository } from '@/lib/server/repositories/inboxRepository';
import { gapsRepository } from '@/lib/server/repositories/gapsRepository';
import type { CapabilityGap } from './types';

export async function handleGap(gap: CapabilityGap): Promise<void> {
  await gapsRepository.save({ ...gap, status: 'searching' });

  const search = await searchCapability(gap);
  if (search.match === 'exact' || search.match === 'similar') {
    await gapsRepository.save({ ...gap, status: 'approved' });
    return;
  }
  if (search.match === 'mcp_available') {
    await inboxRepository.create({
      type: 'mcp_install_suggestion',
      payload: { gap, mcpServer: search.mcpServer },
    });
    return;
  }

  await gapsRepository.save({ ...gap, status: 'forging' });
  const { workdir, manifestPath } = await forgeCapability(gap);

  await gapsRepository.save({ ...gap, status: 'verifying' });
  const report = await verify(workdir);
  if (!report.passed) {
    await gapsRepository.save({ ...gap, status: 'failed' });
    await inboxRepository.create({ type: 'forge_failed', payload: { gap, report } });
    return;
  }

  await inboxRepository.create({
    type: 'forge_approval',
    payload: { gap, manifest: report.manifest, workdir, report },
  });
}

export async function approveForge(opts: {
  gapId: string;
  workdir: string;
  manifest: any;
  approvedBy: string;
}) {
  const forged = await install(opts);
  await gapsRepository.update(opts.gapId, { status: 'approved' });
  // 唤醒被阻塞的主 agent
  return forged;
}
```

---

## 6. 审批 UI

`src/components/execution/ForgeApprovalCard.tsx`：

```tsx
'use client';
import { useState } from 'react';

interface Props {
  gapId: string;
  workdir: string;
  manifest: { id: string; description: string; sideEffect: string; credentials: any[] };
  report: {
    smokeTest: { passed: boolean; output: string };
    staticScan: { passed: boolean; findings: string[] };
  };
  codeSnippet: string;
}

export function ForgeApprovalCard(p: Props) {
  const [tab, setTab] = useState<'desc'|'code'|'tests'|'scan'>('desc');

  async function decide(approved: boolean) {
    await fetch('/api/forge/decide', {
      method: 'POST',
      body: JSON.stringify({ gapId: p.gapId, approved }),
    });
  }

  return (
    <div className="border rounded p-4">
      <h4>Agent 想新增能力：{p.manifest.id}</h4>
      <div className="tabs">
        <button onClick={() => setTab('desc')}>描述</button>
        <button onClick={() => setTab('code')}>代码</button>
        <button onClick={() => setTab('tests')}>测试</button>
        <button onClick={() => setTab('scan')}>扫描</button>
      </div>
      {tab === 'desc' && (
        <div>
          <p>{p.manifest.description}</p>
          <p>副作用等级：{p.manifest.sideEffect}</p>
          <p>需要凭证：{p.manifest.credentials.map(c => c.name).join(', ') || '无'}</p>
        </div>
      )}
      {tab === 'code' && <pre className="text-xs overflow-auto max-h-64">{p.codeSnippet}</pre>}
      {tab === 'tests' && (
        <pre className={`text-xs ${p.report.smokeTest.passed ? 'text-green-600' : 'text-red-600'}`}>
          {p.report.smokeTest.output}
        </pre>
      )}
      {tab === 'scan' && (
        <ul className="text-xs">
          {p.report.staticScan.findings.length === 0
            ? <li className="text-green-600">无风险发现</li>
            : p.report.staticScan.findings.map((f,i) => <li key={i} className="text-red-600">{f}</li>)}
        </ul>
      )}
      <div className="flex gap-2 mt-3">
        <button onClick={() => decide(true)}>批准注册</button>
        <button onClick={() => decide(false)}>拒绝</button>
      </div>
    </div>
  );
}
```

---

## 7. 数据库迁移

`src/lib/server/db/migrations/0003_forge.sql`：

```sql
CREATE TABLE IF NOT EXISTS capability_gaps (
  id TEXT PRIMARY KEY,
  intent TEXT NOT NULL,
  expected_inputs TEXT,
  expected_outputs TEXT,
  blocking_execution_id TEXT NOT NULL,
  status TEXT NOT NULL,
  detected_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS forged_capabilities (
  id TEXT PRIMARY KEY,
  gap_id TEXT NOT NULL,
  trust_level TEXT NOT NULL DEFAULT 'experimental',
  manifest TEXT NOT NULL,
  files_path TEXT NOT NULL,
  approved_by TEXT,
  approved_at TEXT,
  usage_calls INTEGER DEFAULT 0,
  usage_failures INTEGER DEFAULT 0,
  last_used_at TEXT
);
```

---

## 8. SKILL.md 模板（给锻造子 Agent 的硬约束样例）

```markdown
---
name: <capability_id>
description: <一句话描述>
---

# <Capability Name>

## 功能
<这个 capability 做什么>

## 调用方式
\`\`\`ts
import { invoke } from './src/handler';
await invoke({ /* 参数 */ }, ctx);
\`\`\`

## 副作用
<none | reversible | irreversible> — <理由>

## 凭证
- name: GMAIL_OAUTH_TOKEN
  scope: gmail.send
  required: true

## 网络
allowlist:
  - https://www.googleapis.com
```

---

## 9. 风险清单与对策

| 风险 | 对策 |
|---|---|
| Agent 偷懒乱造（mock 通过测试但实际不可用） | 测试必须包含真实输出验证；首次真实使用再走一次审批；监控成功率，连续失败降级 quarantined |
| 能力爆炸 / 重复造 | search 阶段强制 embedding 相似度匹配；定期跑去重；prompt 里明确列出现有能力先选后造 |
| Prompt injection 触发恶意造工具 | 造工具请求必须来自 capability_gap 信号，不能来自外部内容；锻造子 Agent 网络白名单（仅 npm/pypi）；静态扫描兜底；首次人工闸 |
| 凭证管理失控 | 凭证经平台凭证服务，不落到 capability 代码或文件；按 scope 颁发临时 token；capabilities 之间默认不能互访凭证；审计日志 |
| 质量参差导致用户失去信任 | UI 区分 builtin / verified-forged / experimental；关键场景禁用 forged；展示成功率，差的建议切换到官方 MCP |
| 依赖污染 / 供应链攻击 | 锁版本（package-lock 必须）；定期审计；capabilities 跑容器/虚拟环境隔离 |
| 跨用户能力泄漏 | 注册表分级 user-private / team-shared / system-global；默认 user-private；凭证不复用 |
| 能力过界（声明的副作用比实际小） | manifest 必须声明精确边界；运行时用 seccomp/AppArmor/网络 namespace 强制；静态扫描发现"能力比声明的更强"则拒绝 |

---

## 10. 落地步骤（建议 4 周，且必须在方案 1+2 稳定后启动）

| 周 | 任务 |
|---|---|
| 第 1 周 | `capability_gap` 信号定义 + `detector` + `searcher`（仅本地 registry） |
| 第 2 周 | `forger` 子会话 + 锻造模板 + 产物结构校验 |
| 第 3 周 | `verifier`：smoke test runner + dry-run 沙箱 + 静态扫描集成 |
| 第 3 周 | `approver` + ForgeApprovalCard + 收件箱集成 |
| 第 4 周 | `installer` + `~/.claude/skills/` 落盘 + 主 agentRunner 恢复 |
| 第 4 周 | 端到端：模拟"发邮件"缺口 → forge → 审批 → 注册 → 复用 |

---

## 11. 三步演进路径（不要一次到位）

### 阶段 A：手动锻造（2 周内可跑通）

- 实现 capability_gap 信号检测和上报
- 缺能力时**不自动造**，而是收件箱通知"Agent 需要 X 能力，是否让它生成？"
- 用户点同意 → 启动锻造子 Agent → 产出 PR-like 的能力包 → **开发者人工 review** → merge 到 builtin
- **这一步 Agent 是"贡献者"，不是"自治者"**

### 阶段 B：半自动锻造（产品稳定后）

- 引入 `experimental` trustLevel
- 锻造产物自动进入 experimental 池，用户审批后可在 user-private 范围使用
- 不能晋升到 verified/global，除非开发者手动 review
- 监控 experimental 能力的成功率、安全事件

### 阶段 C：完全自治（远期）

- 当 forge 流程产出质量稳定（成功率 / 安全事件率达到阈值）
- 引入"能力市场"：experimental 能力可被其他用户发现、试用、投票
- 高使用率 + 零安全事件的能力可以晋升到 verified
- 多次使用且广泛认可的能力由开发团队"收编"重写为 builtin

---

## 12. 验收标准

- ✅ 触发一次 `capability_gap` 后，能在收件箱看到 forge_approval 卡片
- ✅ 用户批准后，文件落到 `~/.claude/skills/<id>/`，下次启动主 agent 能识别
- ✅ 同一缺口再次出现时，searcher 命中已有能力，不重复锻造
- ✅ 拒绝后 forge 工作目录被清理，主任务进入 failed 状态
- ✅ 静态扫描发现 ≥1 个 finding 时，不进入审批流，自动 reject
- ✅ 凭证不出现在 forged 代码文件中（grep `process.env`、硬编码字符串扫描）

---

## 13. 副产品（这套机制建好后会自然带来）

- **可解释的能力图谱**：每个能力有完整的"它是怎么来的"血缘
- **自然的产品需求挖掘**：高频 capability_gap 就是下个迭代该 builtin 化的能力
- **跨用户知识沉淀**：用户 A 造的小众能力，用户 B 也需要时平台推荐复用，形成网络效应
- **降低产品冷启动门槛**：发布时只带 10 个核心 builtin，用户用着用着自己长出来

---

## 14. 不在本方案范围

- block JSON 渲染（→ 方案 1）
- 主任务执行循环（→ 方案 2）
- 能力市场 / 跨用户共享（远期，依赖账户体系）
- 能力计费 / 配额管理（依赖商业化方案）

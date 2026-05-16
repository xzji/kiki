# KiKi 多形态产物 + 可视化呈现：完整设计方案

> 项目：`xzji/kiki`
> 参考：[《智能体 AI 权威指南》(yeasy)](https://yeasy.gitbook.io/agentic_ai_guide/)
> 状态：方案稿 v1
> 适用范围：让 KiKi 从"任务结果只能是 JSON / Block"演进到"任务结果可以是 iOS App、网页、文档、图片、视频等多形态产物，并以高可读、可交互方式呈现"

---

## 0. TL;DR

- **核心问题不是"输出格式不够多",而是"指令面与产物面没有分离"**:KiKi 现在把"模型的调用指令"和"任务的最终交付物"挤在同一个 JSON 里,导致 iOS App、网页 bundle、视频这种非文本产物无处安放。
- **解法是把系统拆成三个平面**:
  - **控制平面 (JSON)** —— 模型告诉 Harness 调什么工具,继续严格 JSON
  - **数据平面 (Artifact)** —— 真正的字节流,由 Runner 在沙箱里产生,落到文件系统/对象存储
  - **呈现平面 (Presentation)** —— 模型只做"选组件 + 填数据"的 UI 编辑器,前端按声明式契约渲染
- **可视化策略采取 A/B/C 三层**:预制组件库 (覆盖 80%) + 受限 DSL (覆盖 18%) + 沙箱 iframe 跑真代码 (覆盖 2% 重型任务),共存而非互斥。
- **关键原则**:模型不画 UI,只填数据;强 JSON 不松绑(只在数据平面解放);所有用户交互可回流成 Agent 下一轮输入;Schema-valid ≠ 交付完成,必须有 Evaluator。

---

## 0.1 术语表

| 术语 | 含义 | 在本方案中的位置 |
|---|---|---|
| **控制平面 (Control Plane)** | 模型输出的、用于调度 Harness 的结构化 JSON | §2、§6 |
| **数据平面 (Data Plane)** | 任务真正的字节流产物,由 Runner 在沙箱里产生 | §3 |
| **呈现平面 (Presentation Plane)** | 用户看到的 UI 契约,模型只"选组件 + 填数据" | §4 |
| **Artifact** | 数据平面的一等公民,统一封装 ipa/zip/mp4/html 等多形态产物 | §3.1 |
| **ArtifactRef** | Artifact 的轻量引用 (id + 摘要),可塞进上下文不爆 token | §3.1 |
| **Runner** | Harness 的可插拔执行器,把模型指令翻译成沙箱里的真实动作 | §3.3 |
| **Presentation** | 呈现平面契约,有 component/ui_tree/sandbox 三种 kind | §4.2 |
| **Evaluator** | 任务终止条件的真正裁判,验收产物是否可用 | §3.4 |
| **Harness** | 模型的"操作系统":包含 Runner、Artifact 注册表、上下文、安全策略 | 全文 |
| **PGE** | Planner / Generator / Evaluator 三角色闭环 (指南 9.2.6) | §3.4、§6 |

---

## 1. 背景与问题

### 1.1 当前 KiKi 输出层的强 JSON 约束

通过对 `xzji/kiki` 仓库的分析,JSON 约束已经吃进**五个层级**:

| 层级 | 落点 | 关键代码 |
|---|---|---|
| Prompt 模板 | 硬性写"只能输出严格 JSON" | `src/lib/server/goalPlanning.ts` 中的 7 个 `build*Prompt`、`src/lib/server/goalTaskPrompt.ts` 的 `buildGoalTaskRunnerPrompt` |
| CLI 协议 | spawn 参数限定 JSON 流 | `runClaudeJson` (`goalPlanning.ts:588`):`spawn(cliPath, ["-p", "--output-format", "json", ...])` |
| 解析与修复 | 多级 JSON 修复管道 | `parseClaudeJson` (`goalPlanning.ts:795-898`)、`src/lib/server/jsonExtraction.ts`、`src/lib/taskResult/parseAndRepair.ts`、`localValidation.ts` |
| 领域类型 | block/primaryFormat 枚举封死 | `src/types/taskResult.ts`:8 种 block + 6 种 primaryFormat + 6 种 executionKind |
| 渲染层 | switch-case 死分发 | `src/components/execution/BlockRenderer.tsx` + 6 个固定 ExecutionView |

### 1.2 这套约束在多形态任务下的缺口

1. **类型枚举封死**:新增 `web_app / ios_app / file_bundle / image / video / archive` 需要全栈级联改动。
2. **artifacts 仅是文本附件**:`artifact.kind ∈ {markdown,text,json,code,link,other}`,`content` 是字符串,无法承载二进制文件、目录、构建产物。
3. **执行环境单薄**:`runClaudeJson` 一次性 spawn + stdout,缺长任务进度流、退出码校验、产物收集;workspace 只给一个 cwd,没有沙盒、镜像、资源限额。
4. **没有 tool / action / artifact 抽象**:任务流里"做事"和"输出"耦合在同一次 Claude 单轮里。
5. **渲染层只懂 blocks**:不接受 iframe、文件下载、二维码、设备预览;收件箱卡片硬要求 `task_result.blocks`。

### 1.3 指南给出的核心立场

[《智能体 AI 权威指南》](https://yeasy.gitbook.io/agentic_ai_guide/) 4.2 节明确:

> 工具调用并不是魔法,它本质上是一种**结构化输出协议**……模型并没有真的去运行 Python 函数,它只是生成了一段请求运行工具的文本。

9.2 节给出公式:

> **Agent = Model + Harness**;模型是 CPU,Harness 是操作系统。

KiKi 当前几乎只有 Model 部分,Harness 极薄。本方案的本质就是**把 Harness 补出来**。

---

## 2. 整体架构:三平面解耦

```
┌─────────────────────────────────────────────────────────────────┐
│  呈现平面 (Presentation) —— 本方案第二阶段重点                  │
│   路线 A: 预制组件库 (DataTable/Checklist/Form/Chart/...)       │
│   路线 B: 受限 DSL → 编译成 UI                                  │
│   路线 C: 沙箱 iframe 跑真代码 (Claude Artifacts 模式)          │
└─────────────────────────────────────────────────────────────────┘
                          ▲ presentation.component / ui_tree / sandbox
                          │ 交互回流: useAgentAction → /api/agent/feedback
┌─────────────────────────────────────────────────────────────────┐
│  数据平面 (Artifact) —— 本方案第一阶段重点                      │
│   Artifact 注册表:SQLite artifacts 表 + workspace 文件系统     │
│   /api/artifacts/[id] 静态服务、/preview 缩略图                 │
│   字节流:ipa / apk / zip / mp4 / png / html bundle / repo      │
└─────────────────────────────────────────────────────────────────┘
                          ▲ artifact_id 回填上下文
┌─────────────────────────────────────────────────────────────────┐
│  Runner 层 (Harness 执行器,可插拔)                              │
│   ClaudeJsonRunner (现有,文本类)                                │
│   ShellBuildRunner / NodeBuildRunner / XcodeBuildRunner /       │
│   WebappBuildRunner / MediaRenderRunner / ...                   │
│   统一接口:run(input) → { manifest, artifacts, logs, exitCode }│
│   可选能力:requiresSandbox / streaming / evaluator              │
└─────────────────────────────────────────────────────────────────┘
                          ▲ 依据 task.executionKind 选 Runner
┌─────────────────────────────────────────────────────────────────┐
│  控制平面 (JSON) —— 保持严格,不松绑                             │
│   { tool, args, expected_artifact_kinds, presentation_hint }    │
│   只承载"调用什么 / 期望产物形态 / 期望呈现路线"                │
└─────────────────────────────────────────────────────────────────┘
```

**三平面的职责边界**:

| 平面 | 谁产生 | 谁消费 | 形态 |
|---|---|---|---|
| 控制平面 | LLM | Harness/Runner | 严格 JSON |
| 数据平面 | Runner (沙箱内) | 静态服务 / 下游 Runner / 前端 | 字节流 + 元数据 |
| 呈现平面 | LLM (选组件) + 前端 (渲染) | 用户 | 声明式 UI 契约 |

---

## 3. 数据平面:Artifact 一等公民

### 3.1 类型设计

```ts
// src/types/artifact.ts
type Artifact =
  | { kind: 'text_block'; blocks: Block[] }                       // 兼容现状
  | { kind: 'file'; storageRef: string; mime: string; size: number }
  | { kind: 'webapp_bundle'; entryUrl: string; storageRef: string }
  | { kind: 'ios_app'; ipaRef: string; bundleId: string; previewQr?: string }
  | { kind: 'android_app'; apkRef: string; packageName: string }
  | { kind: 'image' | 'video' | 'audio'; storageRef: string; mime: string }
  | { kind: 'archive'; storageRef: string; manifest: FileEntry[] }
  | { kind: 'repo'; storageRef: string; vcs: 'git'; defaultBranch: string }
  | { kind: 'external_link'; url: string };

type ArtifactRef = {
  id: string;          // 全局唯一
  kind: Artifact['kind'];
  summary: string;     // 一行摘要,可塞进上下文
  size?: number;
  mime?: string;
  previewUrl?: string; // 缩略图/截图
};
```

### 3.2 存储与服务

- **物理落盘**:`<conversationWorkspace>/artifacts/<id>/...`,基于已有 `conversationWorkspace.ts` 扩展。
- **元数据**:SQLite 新增 `artifacts` 表 `(id, conversation_id, task_id, kind, storage_path, mime, size, created_at, evaluator_verdict)`,与 `runtime_jobs` 关联。
- **HTTP 接入**:
  - `GET /api/artifacts/[id]` —— 下载 / iframe 预览
  - `GET /api/artifacts/[id]/preview` —— 缩略图 / 截图 / 二维码
  - `GET /api/artifacts/[id]/manifest` —— 目录树 (archive/repo)

### 3.3 Runner 接口

```ts
// src/lib/server/taskRunner/Runner.ts
interface Runner {
  kind: ExecutionKind;
  requiresSandbox: boolean;
  supportsStream: boolean;

  run(input: RunInput, ctx: RunContext): Promise<RunOutput>;
  evaluate?(artifact: Artifact, expectation: Expectation): Promise<Verdict>;
}

type RunOutput = {
  manifest: TaskManifest;     // 模型层结构化输出 (控制平面)
  artifacts: Artifact[];      // 数据平面字节流
  logs: LogEntry[];
  exitCode: number;
};
```

具体 Runner:

| Runner | 处理任务 | 沙箱 | 流式 |
|---|---|---|---|
| `ClaudeJsonRunner` | 现有文本类 (沿用 `runClaudeJson`) | ✗ | ✓(改造) |
| `ShellBuildRunner` | 通用 shell 脚本 / 数据处理 | 推荐 | ✓ |
| `NodeBuildRunner` | npm/pnpm 构建,Vite/Next 网页 | 推荐 | ✓ |
| `XcodeBuildRunner` | iOS App 构建 (.ipa) | 必需 (macOS VM) | ✓ |
| `WebappBuildRunner` | 静态 SPA + 在 iframe 预览 | 推荐 | ✓ |
| `MediaRenderRunner` | ffmpeg / 图像生成 / TTS | 推荐 | ✓ |

### 3.4 Evaluator (Schema-valid ≠ 交付完成)

每个 Runner 可选配 Evaluator,作为任务**真正的终止条件**:

| 产物 | Evaluator 手段 |
|---|---|
| 网页 bundle | headless Chromium 截图 + console error 检查 + lighthouse 分数 |
| iOS App | `xcrun simctl boot` + 启动截图 + 静态扫描 |
| 数据/文档 | JSON schema 校验 + 关键字段断言 |
| 图像/视频 | 分辨率/时长/编码校验 + (可选) 视觉模型抽查 |
| 代码 | lint + typecheck + 单元测试 |

参考指南 9.2.6 的 PGE 三角色 (Planner/Generator/Evaluator) 闭环。

---

## 4. 呈现平面:三路线并存

### 4.1 为什么呈现要单独设计

呈现不是"渲染层多写几个组件",而是独立的**契约问题**。三种反模式都不能选:

| 反模式 | 失败模式 |
|---|---|
| 模型直接吐 HTML / React 代码 | token 慢、易截断、改一处全重生成、无法状态化交互、bug 调试不了 |
| 每次生成完整网页 bundle | 重、慢、不可组合、用户的"再问一句"无法增量更新 |
| 模型只输出 Markdown 让前端"自由发挥" | 高可读但低可交互 |

业界 (Claude Artifacts / ChatGPT Canvas / Vercel v0 / Notion AI / Linear) 已经收敛出答案:**模型选组件 + 模型填数据;组件本身是平台预定义的,模型只负责数据契约。**

### 4.2 Presentation 类型

```ts
// src/types/presentation.ts
type Presentation =
  // 路线 A:预制组件 + 数据
  | { kind: 'component'; component: ComponentName; props: ComponentProps; actions?: ActionSchema[] }
  // 路线 B:DSL 树
  | { kind: 'ui_tree'; root: UINode }
  // 路线 C:沙箱代码
  | { kind: 'sandbox'; runtime: 'react' | 'html' | 'python'; entryArtifactId: string };

type TaskResult = {
  artifacts: ArtifactRef[];      // 数据平面
  presentations: Presentation[]; // 呈现平面 (新增)
  blocks?: Block[];              // 兼容现状
};
```

### 4.3 路线 A:预制组件库 (覆盖 ~80% 场景)

KiKi 现有 8 种 block 全部只读,需要扩成"可交互组件库",至少补:

| 组件 | 交互能力 | 典型场景 |
|---|---|---|
| `data_table` | 列排序、列筛选、行选择、分页、CSV 导出 | 任何"列表型结果" |
| `compare_grid` | 列固定、行高亮、差异着色 | 选型对比 |
| `checklist` | 勾选、跳转子任务 | 行动清单 (KiKi 长程任务天生需要) |
| `kanban` | 拖拽换列、点开看详情 | 任务规划展示 |
| `timeline` | 缩放、节点弹卡片 | 项目排期、调研路径 |
| `chart` (line/bar/pie) | hover、维度筛选、PNG 导出 | 数据分析 |
| `map` | 缩放、标记点详情 | 地理任务 |
| `form` | 字段校验、提交回调 Agent | **关键:让用户"补充信息"返回 Agent** |
| `decision_card` | 按钮触发回调 | "要不要发布" 二次确认 |
| `diff_view` | 行级展开/折叠、接受/拒绝 | 文档/代码修改建议 |
| `media_player` | 播放控制、字幕 | 视频/音频产物 |
| `code_block` | 折叠、复制、语法高亮、可触发"运行"接路线 C | 代码片段 |
| `file_card` | 下载、预览、二维码 | iOS/网页 bundle |

**每个组件除 `props` 还要声明 `actionSchema`** —— 用户的勾选/提交/点击能回调 Agent。

### 4.4 路线 B:受限 DSL → UI 编译 (覆盖 ~18%)

适用于"组件库覆盖不到但又不必动用代码沙箱"的中等复杂度:用户问"做一个能切换今/昨/上周的销售对比看板"。

```json
{
  "kind": "ui_tree",
  "root": {
    "type": "Tabs",
    "tabs": [
      { "label": "今日", "child": { "type": "BarChart", "data": "@artifact:abc#today" } },
      { "label": "昨日", "child": { "type": "BarChart", "data": "@artifact:abc#yesterday" } }
    ]
  }
}
```

要点:

- **白名单语法树** —— 不接受任意 React 代码 (杜绝 XSS)
- **数据用引用** —— `@artifact:id#path` 引用,模型不重复输出大数组
- **组件来自路线 A 的库** —— 容器型 (Tabs/Grid/Card/Accordion) + 叶子复用 A
- **token 量小一个数量级** —— 模型也更不容易写错

参考 Vercel AI SDK Generative UI、Streamlit 声明式风格。

### 4.5 路线 C:沙箱 iframe 跑真代码 (覆盖 ~2% 重型任务)

只在以下场景动用:用户要"一个能跑的 App"、"能自己探索数据的 Notebook"、"模型生成的工具"。

落地:

- **服务端**:Runner 层 `WebappBuildRunner` spawn 子进程跑 vite/esbuild,产物落到 `artifacts/<id>/dist`
- **静态服务**:复用 `/api/artifacts/[id]/preview` serve `dist/index.html`
- **前端**:`<SandboxedIframe sandbox="allow-scripts">` + 严格 CSP + postMessage 双向通信
- **安全**:沙箱 iframe **不能直接调** KiKi API,所有跨域请求由父窗口代理 + 用户确认 (参考 Claude Artifacts 实现)

### 4.6 Streaming:渐进呈现是体感关键

| 路线 | 流式策略 |
|---|---|
| A | 模型流式吐 JSON,前端用 partial-json 解析,组件支持"骨架屏 → 填充" |
| B | DSL 树自顶向下流式,先渲染父容器,子节点 lazy 填充 |
| C | 构建过程实时回流 (`runtime_jobs` 心跳 + SSE),让用户看到"正在 install / build / done" |

KiKi 现有 `runClaudeJson` 一次性 stdout,改成 stream (Claude CLI `--output-format stream-json`),Runner 接口加 `onChunk` 回调。

### 4.7 交互回路:用户操作 → Agent 下一轮输入

KiKi 长程编排的杀手锏。标准回路:

```
用户在 <Checklist> 勾选 3 项
       ↓
前端 dispatch userAction { kind:'checklist_select', items:[...], taskId }
       ↓
/api/agent/feedback 把 action 写回 conversation 上下文
       ↓
goalTaskRunner 下一轮 prompt 自动 append:"用户已确认以下 3 项..."
       ↓
Agent 基于此推进下一个 subgoal
```

实现要点:

- 每个组件的 `actionSchema` 规定 `actionId`
- 前端任何点击/提交统一走 `useAgentAction(actionId, payload)` hook
- 服务端 `/api/agent/feedback` 路由作为唯一回流入口

### 4.8 可降级与一致性

- **同一个 `task_result` 既能渲染富 UI,也能 fallback 成 Markdown** (邮件/IM/导出场景)。每个组件配 `toMarkdown()`。
- **不要让模型动态生成表单字段类型**。预制 10 种字段类型 + 模型选哪种,远比让模型生成动态 schema 稳定。
- **Evaluator 也要管呈现** —— 重型任务跑 headless 截图 + 视觉回归。

---

### 4.9 端到端示例:三个典型任务的完整走线

为了让三平面的协作更具体,下面跑三个不同形态的任务,看每一步发生了什么。

#### 示例 1:文本类任务 —— "对比三家云厂商"

```
用户提问
   ↓
[控制平面] 模型输出 JSON: { tool: 'claude_text', presentation_hint: 'compare_grid' }
   ↓
[Runner] ClaudeJsonRunner 调 Claude CLI 拿到结构化对比数据
   ↓
[数据平面] 产生 1 个 Artifact: { kind:'text_block', blocks:[...] }
              另存 1 个 ArtifactRef 进 SQLite,供后续追溯
   ↓
[呈现平面] Presentation: { kind:'component', component:'compare_grid', props:{...} }
   ↓
[前端] CompareGridView 渲染,用户可排序、可勾选关注列
   ↓
[Evaluator] 字段完整性校验通过 → 任务关闭
```

#### 示例 2:网页类任务 —— "做一个能切换今/昨销售对比的看板"

```
用户提问
   ↓
[控制平面] 模型输出 JSON:
  { tool:'webapp_build', expected_artifact_kinds:['webapp_bundle'],
    presentation_hint:'ui_tree' }
   ↓
[Runner] WebappBuildRunner spawn vite 构建,SSE 流式回传 install/build 进度
   ↓
[数据平面] 产生 Artifact: { kind:'webapp_bundle', entryUrl:'/api/artifacts/abc/preview' }
   ↓
[Evaluator] headless Chromium 截图 + console.error 检查 → 通过
   ↓
[呈现平面] Presentation: { kind:'ui_tree', root:{ type:'Tabs', tabs:[
              { label:'今日', child:{ type:'BarChart', data:'@artifact:abc#today' } },
              { label:'昨日', child:{ type:'BarChart', data:'@artifact:abc#yesterday' } }
            ]}}
   ↓
[前端] DSLRenderer 渲染 Tabs + BarChart
   ↓
用户在 Tab 切换 / hover 柱条 → 全本地交互,无需回 Agent
```

#### 示例 3:重型任务 —— "做一个能跑的简易计算器 App (iOS)"

```
用户提问
   ↓
[控制平面] 模型输出 JSON:
  { tool:'xcode_build', expected_artifact_kinds:['ios_app'],
    presentation_hint:'component:file_card' }
   ↓
[Runner] XcodeBuildRunner 在 macOS VM 沙箱里构建 .ipa
         长任务,SSE 心跳上报 "compiling Swift sources..."
   ↓
[数据平面] 产生 Artifact:
  { kind:'ios_app', ipaRef:'storage://...', bundleId:'com.demo.calc',
    previewQr:'storage://...' }
   ↓
[Evaluator] xcrun simctl boot + 启动截图 + 静态扫描 → 通过
   ↓
[呈现平面] Presentation: { kind:'component', component:'file_card',
            props:{ title:'Calc.ipa', size:..., previewQr:..., actions:['download','simulator_preview'] }}
   ↓
[前端] FileCardView 显示二维码 + 下载按钮 + "在模拟器预览" 按钮
   ↓
用户点击"在模拟器预览" → useAgentAction('simulate', {ipaRef})
   ↓
[交互回路] /api/agent/feedback → 触发 SimulatorRunner 启动模拟器并回传截图
```

三个示例覆盖了从轻到重的完整谱系,展示出**控制平面恒定 / 数据平面按 kind 分支 / 呈现平面三路线按需**的弹性。

---

## 5. KiKi 仓库的具体改造路径

### 5.0 Step 0:动手前的准备

| 准备项 | 动作 |
|---|---|
| 分支策略 | 主线开 `feat/multiplane`;数据平面、呈现平面拆两个子分支并行 |
| Feature Flag | 加 `KIKI_FEATURE_MULTIPLANE=on/off`,默认 off,小流量灰度 |
| 兼容基线 | 现有任务必须 100% 在 flag off 下行为不变;flag on 下旧任务自动适配为 `kind:'text_block'` Artifact |
| 数据迁移 | 写 `migrations/0001_add_artifacts.sql`;旧 `task_result.artifacts` 字段在线读时双写一份 ArtifactRef |
| 灰度入口 | 先在内部 `/playground` 路由放新呈现层,稳定后再切主入口 |
| 回滚预案 | 任意一步可独立回滚;数据库迁移用 expand-contract 模式 (先加字段再删旧字段) |

### 5.1 第一阶段:数据平面 (Step 1-5)

| 步骤 | 文件 / 模块 | 动作 |
|---|---|---|
| **1. Artifact 类型** | `src/types/artifact.ts` 新建;`src/types/taskResult.ts` 把 `artifacts` 改为 `ArtifactRef[]` | 类型基础 |
| **2. 拆 prompt schema** | `src/lib/taskResult/schemaForPrompt.ts` 拆 `BASE_FRAGMENT` + `byPrimaryFormat[...]`;`goalTaskPrompt.ts` 模板按 `primaryFormat` 选片段;`goalPlanning.ts` 三个白名单扩枚举 | 让模型知道"非文本任务不必塞 blocks" |
| **3. Runner 抽象** | `src/lib/server/taskRunner/` 新建 `Runner.ts` + `ClaudeJsonRunner.ts`(搬现有逻辑);后续接 `Shell/Node/Xcode/Webapp/MediaRunner`;`goalTaskRunner.ts` 按 `executionKind` 派发;`kiki-runtime-daemon.ts` + `taskDispatchWorker.ts` 加心跳 | 核心一招 |
| **4. Artifact 存储 + 静态服务** | `src/lib/server/workspace/artifactStorage.ts`;SQLite `artifacts` 表;`GET /api/artifacts/[id]` + `/preview` + `/manifest` | 数据平面物理基础 |
| **5. 渲染分发** | `src/components/execution/ArtifactRenderer.tsx` 按 `artifact.kind` 分发;新增 `WebAppPreview / MobileAppArtifact / FileBundleView / MediaPreview`;`BlockRenderer.tsx` 保留作为 `text_block` 的子 View | 用户能看到产物 |

### 5.2 第二阶段:呈现平面 (Step 6-11)

| 步骤 | 文件 / 模块 | 动作 |
|---|---|---|
| **6. Presentation 类型** | `src/types/presentation.ts`;`taskResult.ts` 加 `presentations` | 第三平面建立 |
| **7. 扩组件库** | `src/components/execution/blocks/` 从 8 种扩到 ~15 种,每个声明 `actionSchema` | 路线 A 主力 |
| **8. DSL 渲染器** | `src/components/execution/DSLRenderer.tsx` + `src/lib/dsl/parser.ts`;先支持 5-6 种容器 + `@artifact:id#path` 引用 | 路线 B |
| **9. Sandbox iframe** | `src/components/execution/SandboxedArtifact.tsx`;服务端 `WebappBuildRunner`;CSP + postMessage 代理 | 路线 C(后置) |
| **10. 流式 + 交互回路** | `runClaudeJson` 改 stream;`/api/agent/feedback`;`useAgentAction` hook | 让呈现"活"起来 |
| **11. Prompt 引导选呈现** | `goalTaskPrompt.ts` 增 "presentation_decision" 段:先决定 component/ui_tree/sandbox,再填内容 | 模型成为"UI 编辑器" |

### 5.3 关键源码路径速查

- `src/lib/server/goalPlanning.ts` —— prompt + 解析 + 校验流水线
- `src/lib/server/goalTaskPrompt.ts` —— 任务执行 prompt 与输出模板
- `src/lib/server/goalTaskRunner.ts` —— 任务运行时主循环
- `src/lib/server/jsonExtraction.ts` —— JSON 截取
- `src/lib/taskResult/{parseAndRepair,localValidation,schemaForPrompt}.ts` —— schema 修复与 prompt 注入
- `src/types/{taskResult,kiki}.ts` —— 领域类型,多形态扩展第一站
- `src/components/execution/BlockRenderer.tsx` 及 6 个 View —— 渲染分发口
- `src/lib/server/workspace/conversationWorkspace.ts`、`src/bin/kiki-runtime-daemon.ts`、`src/lib/server/worker/taskDispatchWorker.ts` —— 执行/产物落地的物理基础

---

## 6. 设计原则速查 (照着做不踩坑)

1. **JSON 是控制平面,artifact 走数据平面** (指南 4.2):模型 JSON 只承载"调什么工具",真正字节流由 Harness 落盘。
2. **指令协议 ≠ 呈现形式** (指南 4.4):工具服务处理连接,Skill 处理呈现;不要让一个 Schema 同时绑死调用结构和交付物结构。
3. **执行层 / 计算层分离** (指南 9.2):凭证、策略、审计留 Harness;构建/渲染/视频留 sandbox;沙箱默认不可信,破坏性产出走二次确认。
4. **Schema-valid ≠ 交付完成** (指南 4.2.6 + 9.2.6):必须有 Evaluator 验收 (截图/跑测试/lint/视觉回归)。
5. **artifact 优先于消息历史做状态传递** (指南 9.1.5 + 9.2.3):用文件系统/对象存储索引,不要塞进对话窗口。
6. **强 JSON 不要松** —— 控制平面纪律必须保留;要松的是数据平面对 JSON 的依赖。
7. **模型不画 UI,只填数据** —— 除非进路线 C 沙箱;能把 token 成本降一个数量级。
8. **可交互不等于万能控件** —— 预制类型 + 模型选,远比模型生成动态 schema 稳定。
9. **呈现要可降级** —— 同一 result 既能富 UI 也能 Markdown。
10. **不要追求一次性完美** —— A → B → C 渐进式发布,Vercel v0 也花了一年。

---

## 7. 渐进式发布建议 (6 周参考排期)

| 周 | 目标 | 关键交付 |
|---|---|---|
| W1 | 数据平面骨架 | Step 1 (Artifact 类型) + Step 4 一半 (artifactStorage + SQLite 表) |
| W2 | Runner 抽象 | Step 3 (Runner 接口 + ClaudeJsonRunner 兼容现状) + Step 5 一半 (ArtifactRenderer 雏形) |
| W3 | 第一类多形态 | Step 2 (prompt schema 拆分) + 接入 `WebappBuildRunner` 一个端到端 demo |
| W4 | Presentation 类型 + 组件库 | Step 6 + Step 7 (5-6 个核心新组件:DataTable/Checklist/Form/FileCard/Chart) |
| W5 | 流式 + 交互回路 | Step 10 + Step 11 (prompt 引导选呈现) |
| W6 | DSL + Sandbox 起步 | Step 8 (DSL 容器 + 引用) + Step 9 雏形 (受控 iframe) + 1 个 Evaluator (网页截图) |

---

## 8. 风险与开放问题

| 风险 | 应对 |
|---|---|
| 沙箱选型 (Docker / Firecracker / macOS VM / E2B) 周期长 | 第 3 步 Runner 接口预留 `requiresSandbox` 字段,真有 iOS / 重构建任务时再补,不阻塞主线 |
| 模型对"选呈现路线"的判断不稳 | prompt 加 few-shot;前端做 fallback (路线 B/C 失败降级到 A) |
| token 成本上升 (新增 presentation 字段) | 用 `@artifact:id#path` 引用,大数据不进 prompt |
| 旧任务/旧数据兼容 | `text_block` 作为 Artifact 第一种 kind;`BlockRenderer` 保留;DB 迁移加默认值 |
| Evaluator 漏检 | 多层防御:lint + 测试 + 截图 + 关键字段断言;重大产物上线前人工接管 (指南 4.5 敏感操作分级) |
| 安全 (沙箱 iframe / 跨域 / 用户上传) | CSP + sandbox 属性 + postMessage 代理 + 凭证不出 Harness |

---

### 8.1 可观测性与调试

多平面架构最大的工程化坑是"出问题时不知道是哪一层的锅"。三层各自要补的可观测能力:

| 层 | 关键观测点 | 工具/手段 |
|---|---|---|
| 控制平面 | 模型 JSON 输出、JSON 修复次数、schema 校验失败率 | 已有 `parseClaudeJson` 多级修复埋点扩 metric;失败样本入 `runtime_jobs` |
| Runner / 数据平面 | Runner 选择决策、构建时长、退出码、产物大小、Evaluator 结论 | 每个 Runner 输出结构化 `RunRecord`;SQLite `runner_records` 表 |
| 呈现平面 | 模型选了哪种呈现路线、组件 props 有效性、用户交互事件 | `useAgentAction` 上报全部 actionId + payload;前端错误边界捕获渲染失败 |
| 端到端 | 一次任务跨三平面的全 trace | 引入 `correlationId`,贯穿 prompt → Runner → Artifact → Presentation → User Action |

**任务回放能力**:每个 `correlationId` 关联的 prompt 输入、模型输出、Artifact id、Presentation 契约、用户交互全部留痕,支持"重放任意一步"用于调试模型回归 (这是指南 9.2 蓝图文件思想的延伸)。

**调试入口**:`/admin/trace/<correlationId>` 时间线视图,把三平面事件合并展示,定位"模型选错呈现 / Runner 失败 / 渲染崩溃"是哪一层的事。

---

### 8.2 成功度量 (Definition of Done)

> 评审时被问"做完了怎么算成功?"——这一节就是答案。

| 维度 | 指标 | 目标值 (上线 6 周后) |
|---|---|---|
| 形态覆盖 | 支持的 Artifact `kind` 数 | ≥ 6 (text_block / file / webapp_bundle / image / archive / external_link) |
| 任务成功率 | flag-on 下任务 Evaluator 通过率 | ≥ flag-off 基线 - 3pp (不显著回退) |
| 模型选路准确性 | 模型选 component/ui_tree/sandbox 与人工标注一致率 | ≥ 85% |
| 交互闭环率 | 用户产生交互后,Agent 在下一轮正确利用该交互的比例 | ≥ 70% |
| 性能 | 文本类任务首字时间 (TTFT) | 不劣化于现状 (流式改造) |
| 性能 | 网页类任务从指令到 iframe 可见 | P50 ≤ 30s,P95 ≤ 90s |
| 兼容性 | flag-off 模式下,所有现有自动化测试 | 100% 通过 |
| 安全 | 沙箱 iframe 无 CSP 违规告警 | 0 critical |
| 可观测 | 每个失败任务能在 trace UI 一屏定位故障层 | 100% |

**验收方式**:
- 选 20 个有代表性的真实历史任务做对照实验 (新旧架构都跑,人工对比)
- 引入 5 个新形态任务作为 smoke 测试集,纳入 CI

---

## 9. 一句话总结

> **把 KiKi 现在"模型输出 JSON 即最终产物"的单平面架构,演进为三平面解耦:控制平面 JSON 严格不变 → 数据平面 Artifact 多形态字节流 → 呈现平面三路线 (组件/DSL/沙箱) 可交互可降级。智能在模型里,可靠性在 Harness 里。**

---

## 附录 A:与指南章节的对应关系

| 本方案要点 | 指南章节 |
|---|---|
| JSON 是结构化输出协议,不是终态产物 | 4.2 工具使用机制 |
| 工具服务处理连接,Skill 处理呈现 | 4.4 智能体技能 |
| Computer Use / 浏览器自动化 / 三层防御 / 敏感操作分级 | 4.5 浏览器与 Computer Use |
| Agent 是创意导演,通过工具调用底层生成模型 | 4.6 多模态能力 |
| 蓝图文件 / Agentic Workflows 四层 | 9.1 设计模式 |
| Agent = Model + Harness;PGE 三角色;执行/计算分离 | 9.2 Harness 架构 |
| Prompt → Context → Harness Engineering | 10.1 编程范式转移 |

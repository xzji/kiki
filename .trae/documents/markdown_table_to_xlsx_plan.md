# Markdown 表格清单 → Excel 下载 / 轻量在线编辑方案

## 一、背景与目标

当前 Agent 任务（如「护照签证确认清单（20人）」）会输出形如下面的 Markdown 文件：

```
| 序号 | 姓名 | 护照号 | 有效期 | 签证状态 | 备注 | 核对结果 |
| 1 | | | | | | □合格 □需处理 |
...
```

经 [MarkdownRenderer.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/common/MarkdownRenderer.tsx) 渲染为只读 `<table>`。问题：

- 用户**无法在表格里直接填写**（截图所示空白单元格只能用眼睛看，键盘打不进去）；
- 也**无法导出为可编辑文件**（目前只能下载 `.md`，对非技术用户不友好）。

目标：让这种以填表为目的的清单类产物，**同时拥有 `.xlsx` 下载入口**，并在卡片上提供**就地预览/轻量编辑**能力（导出的就是用户编辑后的内容）。

---

## 二、现状分析（基于 Phase 1 探索）

### 1. 文件产物落盘链路（端到端）

| 阶段 | 关键位置 |
|---|---|
| Prompt 契约 | [schemaForPrompt.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/taskResult/schemaForPrompt.ts) — `FILE_ARTIFACT_PROMPT_FRAGMENT` 规定 `files: [{filename, mime, content}]`，**白名单 `.md/.txt/.csv/.json`** |
| 解析 | [goalTaskRunner.ts L1137-1144](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskRunner.ts#L1137-L1144) `extractFileWriteSpecs` |
| 校验 | [fileWriteSpecs.ts L24](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/fileWriteSpecs.ts#L24) `/\.(md|txt|csv|json)$/i` 硬性过滤 |
| 落盘 | [goalTaskRunner.ts L2444-2456](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskRunner.ts#L2444-L2456) `persistFileArtifact({ bytes: file.content })` |
| 存储 | [artifactStorage.ts L161-207](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/workspace/artifactStorage.ts#L161-L207) — `bytes: Buffer | string` 已经原生支持二进制 |
| 下载 API | [src/app/api/artifacts/[id]/route.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/app/api/artifacts/%5Bid%5D/route.ts) — `fs.createReadStream` + `Content-Type: artifact.mime` |
| 卡片 UI | [FileCard.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/execution/FileCard.tsx) — 「预览 / 下载」按钮 |
| Markdown 渲染 | [MarkdownRenderer.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/common/MarkdownRenderer.tsx) — 自研 parser，已有 `table` block（headers + rows） |

### 2. 关键发现

- **存储层是二进制安全的**：`persistFileArtifact` 已经接受 `Buffer`，下载 API 直接流式输出。瓶颈只在 prompt 协议和 normalize 的扩展名白名单。
- **没有任何 spreadsheet 依赖**（`xlsx / exceljs / sheetjs / handsontable / react-spreadsheet` 均无）。
- **Markdown 表格解析逻辑已存在**（`splitTableRow / looksLikeTable / parseMarkdown`），可抽取复用到服务端。
- 现有 `comparison_table` block 走的是结构化数据（[BlockRenderer.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/execution/BlockRenderer.tsx) 直接渲染 `<table>`），与本方案无关 —— 我们针对的是 agent 直接产出 `.md` 文件中的表格场景。

### 3. 数据样例验证

实际产物 [passport_visa_checklist.md](file:///Users/bytedance/Documents/trae/long_horizon_agent/data/workspaces/conversations/conv-new-1779270263266/tasks/task-opq-mpdzidwi-k3y7puou/inst-opq-mpeyr3gy-62ncr69k/passport_visa_checklist.md) 文件内含两张 GFM 表格（20 行清单 + 4 行统计），完全符合自动派生场景。

---

## 三、方案对比与决策

### 维度

| 方案 | 复杂度 | Agent 协议改动 | 用户体验 |
|---|---|---|---|
| **A. 自动派生**：runner 解析 `.md` 中的 GFM 表格，额外落一份 `.xlsx` | 低 | 0 | 多一个下载按钮；只读编辑 |
| **B. Agent 显式产出 xlsx**：放宽 prompt 让 agent 直接给 base64/sheets | 中 | 大 | Agent 可控更多样式；但失败率↑ |
| **C. 在线编辑器**：FileCard 内嵌可编辑表格，编辑后导出 | 中-高 | 0 | 用户可直接填写并导出 |

### 决策：**A + C 组合**（分阶段交付）

- **阶段 1（核心，本次实施）**：方案 A —— 服务端自动从 `.md` 派生 `.xlsx` 同名副本；FileCard 多一个 xlsx 下载入口。**Agent 视角无感知，向后完全兼容**。
- **阶段 2（增强，本次同步实施）**：方案 C 的轻量版 —— 给 xlsx artifact 增加「内嵌可编辑预览」组件，用户在 UI 内修改表格 → 点击「下载已填写版本」时由前端用 SheetJS 重新打包 xlsx 下载。**不写回服务端**（避免引入服务端 PUT、并发、权限等复杂度，符合 server-authoritative 原则）。
- 不选 B：放宽 agent 协议会扩大失败面，且 prompt 调试成本高，不符合「最小改动半径」与「保留原始现场」的约束。

### 选型：`exceljs`（服务端） + `xlsx`（SheetJS，浏览器端）

- **服务端 `exceljs`**：API 友好、TypeScript 类型完备、写出可读性更好（含样式/宽度），无 browser-only 依赖。
- **浏览器端 `xlsx` (SheetJS Community)**：体积可接受（按需 import），读取/写入兼容性最好；与 exceljs 相比浏览器侧打包更轻。
- 仅在客户端组件里 dynamic import，避免污染 SSR 体积。

---

## 四、实施步骤

### Step 1：依赖安装

在 [package.json](file:///Users/bytedance/Documents/trae/long_horizon_agent/package.json) 添加：

- `exceljs`（dependencies） — 服务端构建 xlsx
- `xlsx`（dependencies） — 浏览器侧读/写 xlsx（SheetJS）

> 命令：`pnpm add exceljs xlsx`

### Step 2：抽取共享 Markdown 表格解析 util（服务端可用）

新增 [src/lib/markdown/parseMarkdownTables.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/markdown/parseMarkdownTables.ts)：

- 导出 `parseMarkdownTables(markdown: string): Array<{ title?: string; headers: string[]; rows: string[][] }>`
- 复用 [MarkdownRenderer.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/common/MarkdownRenderer.tsx) 中既有的 `splitTableRow` / `TABLE_SEPARATOR_RE` 逻辑（移到 util，再让 MarkdownRenderer 反向引用，避免重复实现）。
- `title` 取该表上方最近的 heading 文本，没有则给默认 `Sheet1/Sheet2...`。

> 注意：目前 `MarkdownRenderer.tsx` 是 `"use client"`，需要把纯解析函数拆到一个无 React 依赖的纯 ts 文件，确保可在 Node 侧 import。

### Step 3：服务端 Markdown → XLSX 构建器

新增 [src/lib/server/workspace/markdownToXlsx.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/workspace/markdownToXlsx.ts)：

- 导出 `buildXlsxFromMarkdown(markdown: string): { buffer: Buffer; sheetCount: number } | null`
- 内部用 `exceljs.Workbook`：
  - 每张 GFM 表 → 一个 worksheet（sheet 名取 `title`，做 31 字符截断 + 非法字符替换）；
  - 第一行为 headers，加粗、底色 `#F4F8FF`；
  - 列宽自适应（取 `max(headers/cells.length, 8) + 2`，封顶 40）；
  - 单元格自动 `wrapText: true`。
- 若输入不含任何表格，返回 `null`，调用方据此决定不派生。

### Step 4：Runner 落盘后自动派生 xlsx 副本

在 [goalTaskRunner.ts L2448-2459](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskRunner.ts#L2448-L2459) `files.map((file) => persistFileArtifact(...))` 之后追加一段逻辑：

- 仅对 `file.filename` 以 `.md` 结尾的文件进行派生；
- 调用 `buildXlsxFromMarkdown(file.content)`，若返回非 null：
  - 派生文件名：去掉 `.md` 后缀加 `.xlsx`（如 `passport_visa_checklist.md` → `passport_visa_checklist.xlsx`）；
  - `persistFileArtifact({ filename, mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", bytes: buffer, label, summary: "自动从 Markdown 表格派生" })`；
  - `toArtifactRef` 后 push 到 `result.taskResult.artifactRefs`，**追加在原 .md ref 之后**，保证 .md 仍是首选展示。
- 在已有的 `appendTrajectory({ status: "running", title: "正在写入文件产物" })` 之后追加一条 `title: "正在派生 Excel 副本"`，保留 trace 现场。
- 失败保护：派生失败（解析异常/写盘异常）只记录 warning trajectory，不影响主流程。

### Step 5：前端 — Excel 内嵌预览/编辑组件

新增 [src/components/execution/SpreadsheetPreview.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/execution/SpreadsheetPreview.tsx)（`"use client"`）：

- Props：`{ artifact: ArtifactRef }`
- 行为：
  1. 折叠态默认收起（与用户的「极简」偏好一致），FileCard 上提供 `展开编辑 / 收起` 链接；
  2. 展开后 `dynamic import("xlsx")`，`fetch(artifact.previewUrl).then(r => r.arrayBuffer())`，`XLSX.read` → 多 sheet tab；
  3. 每个 sheet 渲染为可编辑 `<table>`：每个 `<td>` 用 `contentEditable` 或 `<input>`（保持「无边框/无底色」基线，仅在 hover 时出现底色提示编辑性，对应用户偏好「Hover-to-show」）；
  4. 顶部按钮「下载已填写版本」：用 `XLSX.utils.aoa_to_sheet(...) → XLSX.writeFile(...)` 在客户端打包并触发浏览器下载，**不回写服务端**（保持 server-authoritative：原始 xlsx 在服务端不变）；
  5. 顶部按钮「重置」：丢弃本地编辑，重新从远端读取。
- 状态：纯 `useState` 本地态；不接入 zustand（属于「非持久化覆盖」，符合 user_profile）。

### Step 6：FileCard 对 xlsx 启用嵌入预览

修改 [FileCard.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/execution/FileCard.tsx)：

- 检测 `artifact.mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"` 或文件名以 `.xlsx` 结尾；
- 满足时：
  - 卡片底部显示一个文字按钮 `展开为可编辑表格`；
  - 点击后渲染 `<SpreadsheetPreview artifact={artifact} />`（懒加载，`React.lazy` 或 `next/dynamic`）；
  - 保留原有「下载」按钮作为「下载原始模板」。
- 其他文件类型行为不变。

### Step 7（可选小优化）：CSV 同步派生

`buildXlsxFromMarkdown` 可顺带提供 `buildCsvFromMarkdown`，对每张表派生一个 `.csv`（或当 `.md` 只含一张表时仅派生 csv）。本次**先不实施**，避免堆叠功能，仅在文档列出未来扩展点。

---

## 五、文件变更清单

| 类型 | 路径 | 说明 |
|---|---|---|
| 修改 | [package.json](file:///Users/bytedance/Documents/trae/long_horizon_agent/package.json) | 新增 `exceljs`、`xlsx` |
| 新增 | `src/lib/markdown/parseMarkdownTables.ts` | 服务端可复用的 GFM 表格解析 |
| 修改 | [src/components/common/MarkdownRenderer.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/common/MarkdownRenderer.tsx) | 改为复用上述 util（避免重复实现） |
| 新增 | `src/lib/server/workspace/markdownToXlsx.ts` | exceljs 构建 xlsx Buffer |
| 修改 | [src/lib/server/goalTaskRunner.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskRunner.ts) | 在 .md 落盘后派生 .xlsx |
| 新增 | `src/components/execution/SpreadsheetPreview.tsx` | 客户端 xlsx 预览/编辑 |
| 修改 | [src/components/execution/FileCard.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/execution/FileCard.tsx) | xlsx 文件展开嵌入预览 |

未涉及：types（无需扩展枚举，因 mime 字段是 string 自由）、prompt fragments、agent 角色 prompt、API 路由。

---

## 六、设计决策与假设

1. **派生而非替换**：保留 `.md` 作为人类可读基线，xlsx 作为可编辑增强。一致性由「同名不同后缀」和「summary 文案」表达。
2. **不引入 prompt 协议变更**：避免 agent 失败率上升、prompt 维护负担，与项目「单点写入控制」的稳健性原则一致。
3. **下载即编辑后版本**（前端打包），不回写服务端：避免引入新 PUT 路由 / 并发 / 权限模型；与「server-authoritative state」原则一致 —— 服务端保留原始模板，用户编辑视为本地非持久化覆盖。
4. **依赖体积可接受**：`xlsx` (SheetJS Community) ~700KB gzip，仅在用户主动展开 xlsx 预览时 dynamic import；`exceljs` 仅服务端使用，不影响前端 bundle。
5. **空表场景**：`buildXlsxFromMarkdown` 仅在解析到至少 1 张有效 GFM 表（含分隔行）时派生；纯文本 .md 不会产生空 xlsx。
6. **样式最小**：表头加粗 + 浅蓝底色 + 自适应列宽，**不加边框/网格线**之外的强视觉装饰，遵守用户的「极简」偏好。
7. **错误现场保留**：派生失败仅记录 trajectory warning，主流程不阻塞，遵循「保留原始现场」的 lesson。

---

## 七、验证步骤

1. **构建与类型检查**：`pnpm build` 与 TS 全量检查通过。
2. **本地复现现有任务**：
   - 启动 `pnpm dev`，进入已存在的会话 `conv-new-1779270263266`，定位到护照签证任务 inst；
   - 在 UI 上确认 FileCard 区域同时出现两个文
# 表格清单 → Excel 工具方案（统一封装版 v2.1 · 自检修复版）

> 修订日志：
> - v1：仅 .md 表格 → xlsx
> - v2：抽象 `src/lib/spreadsheet/` 工具模块，三类表格源统一接入
> - **v2.1（本版）：自检后修复 12 处问题**，详见末尾「修订记录」

---

## 一、背景与目标

当前项目里"表格类信息"有三条源路径，但下载/导出/编辑能力是**各自缺失**的：

| 来源 | 现状渲染入口 | 是否可下载 | 是否可编辑 |
|---|---|---|---|
| Agent 产出 `.md` 文件中的 GFM 表格 | [MarkdownRenderer.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/common/MarkdownRenderer.tsx) `case "table"` | 只能下载整份 .md | 否 |
| `comparison_table` block | [BlockRenderer.tsx L61-85](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/execution/BlockRenderer.tsx#L61-L85) | 否 | 否 |
| Markdown block (`block.kind === "markdown"`) 中的表格 | 同 MarkdownRenderer | 否 | 否 |

目标：

1. **抽象出一个通用 Spreadsheet 工具模块**，用统一的 `TableData` 中间表示对接所有源；
2. 服务端基于这个模块自动派生 `.xlsx` 文件 artifact（与现有 .md 同名异后缀，并列展示）；
3. 用户可在 FileCard 上**就地展开 xlsx 编辑**，编辑后下载已填写版本（不写回服务端）；
4. 渲染层（comparison_table、markdown 表格）按需挂上"下载 Excel"工具栏。

---

## 二、目标架构

```
src/lib/spreadsheet/
├── types.ts                  # TableData / SpreadsheetWorkbook 中间表示（pure ts）
├── constants.ts              # XLSX_MIME 等常量
├── adapters/
│   ├── cell.ts               # cellText / cellClassName 抽出（pure ts，BlockRenderer 复用）
│   ├── markdownTables.ts     # markdown 文本 → SpreadsheetWorkbook（pure ts，server+client 都可 import）
│   └── comparisonTableBlock.ts  # ComparisonTableBlock → TableData（pure ts）
├── server/
│   └── buildXlsx.ts          # SpreadsheetWorkbook → Buffer (exceljs，server-only)
└── client/
    └── xlsxIo.ts             # ArrayBuffer ↔ SpreadsheetWorkbook (SheetJS，client-only，动态加载)

src/components/spreadsheet/
├── TablePreview.tsx          # "use client"：渲染 TableData，可选下载工具栏
└── SpreadsheetEditor.tsx     # "use client"：xlsx artifact 展开后的可编辑视图
```

### 中间表示（`types.ts`）

```ts
export interface TableData {
  title?: string;             // sheet 名 / 标题
  headers: string[];
  rows: string[][];           // 全部转字符串，UI tone/格式不带入 xlsx
  highlight?: number[];       // 可选高亮行索引（仅 comparison_table 适配器会填）
}

export interface SpreadsheetWorkbook {
  filename: string;
  tables: TableData[];
}
```

### server / client 隔离（修复 #3）

| 文件 | 模块边界 | 标识 |
|---|---|---|
| `types.ts` / `constants.ts` / `adapters/*.ts` | 纯 ts，二端共用 | 无指令 |
| `server/buildXlsx.ts` | 仅服务端使用（依赖 `exceljs`） | 文件首行 `import "server-only";` |
| `client/xlsxIo.ts` | 仅浏览器使用（依赖 `xlsx` SheetJS） | 文件首行 `"use client";`；调用方一律 **`await import()` 动态加载** |

---

## 三、依赖选型（修复 #2）

| 选型 | 用途 | 为什么 |
|---|---|---|
| **`exceljs`** —— server-only | 服务端把 `SpreadsheetWorkbook` 写成 `.xlsx` Buffer | SheetJS Community Edition **不支持写单元格样式**（加粗/底色/边框需购买 Pro），而我们要做表头加粗 + 浅蓝底色 + 高亮行。`exceljs` 完全开源、API 友好、TS 类型完善 |
| **`xlsx` (SheetJS Community)** —— client-only | 浏览器读 xlsx → 内存表示，编辑后再写出 | 浏览器侧不需要复杂样式（保留服务端构造的样式），只需读写值；体积/性能优于 exceljs-browser；`await import("xlsx")` 仅在用户主动展开/下载时加载 |

> 不引入 handsontable / react-spreadsheet 等重型组件。

---

## 四、实施步骤

### Step 1：依赖

```
pnpm add exceljs xlsx server-only
```

`server-only` 是 Next 官方提供的运行时 enforcement，当被打包进客户端 bundle 时构建报错。

### Step 2：核心模块

**`src/lib/spreadsheet/types.ts`** —— 见上文。

**`src/lib/spreadsheet/constants.ts`**：
```ts
export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
```

**`src/lib/spreadsheet/adapters/cell.ts`**（修复 #1 配套，消除重复实现）：
- 从 [BlockRenderer.tsx L17-28](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/execution/BlockRenderer.tsx#L17-L28) 抽出 `cellText(cell: ResultCell)` 与 `cellClassName(cell: ResultCell)`；
- BlockRenderer 反向 import。

**`src/lib/spreadsheet/adapters/markdownTables.ts`**：
- 导出 `parseTablesFromMarkdown(markdown: string): TableData[]`；
- 导出 `markdownToWorkbook(markdown: string, opts: { filename: string }): SpreadsheetWorkbook | null`（至少 1 张表才返回非 null）；
- 复用现有 [MarkdownRenderer.tsx L16-L56](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/common/MarkdownRenderer.tsx#L16-L56) 中的 `splitTableRow / TABLE_SEPARATOR_RE / looksLikeTable` 逻辑——抽到本文件，MarkdownRenderer 反向 import；
- `title` 取该表上方最近的 heading；无则默认 `Sheet1/Sheet2…`；
- 异常防御（修复 #11）：headers 为空跳过；rows 为空仍生成只含表头的 sheet；列数不一致时按 headers.length 对齐补空。

**`src/lib/spreadsheet/adapters/comparisonTableBlock.ts`**：
- 导出 `comparisonTableBlockToTable(block, opts?): TableData`
- `headers = block.columns`；`rows[i][j] = cellText(block.rows[i][columns[j]] ?? "")`；
- `highlight = block.highlight`（修复 #5：可选透传）。

**`src/lib/spreadsheet/server/buildXlsx.ts`**（首行 `import "server-only";`，使用 `exceljs`）：
- 导出 `buildXlsxBuffer(workbook: SpreadsheetWorkbook): Promise<Buffer>`；
- sheet 名 31 字符截断 + `[\\/?*\[\]]` 替换为 `_`；同名加 `(2)/(3)…`；
- 表头加粗，`fgColor: "FFF4F8FF"`；
- 列宽 = `min(max(8, headerLen, maxCellLen) + 2, 40)`；单元格 `wrapText: true`；
- `highlight` 行 `fgColor: "FFFFF9E8"`；
- 空 workbook 抛错，由调用方 try/catch。

**`src/lib/spreadsheet/client/xlsxIo.ts`**（`"use client"`，调用方一律 dynamic import）：
- 导出 `parseXlsxArrayBuffer(buf: ArrayBuffer): SpreadsheetWorkbook`；
- 导出 `writeWorkbookToBlob(workbook: SpreadsheetWorkbook): Blob`；
- 导出 `writeTableDataToBlob(table: TableData): Blob`（用于 TablePreview 工具栏单表导出）；
- 导出 `triggerBrowserDownload(blob: Blob, filename: string)`：`URL.createObjectURL` + 隐藏 `<a download>`，filename 做安全清洗 + encodeURIComponent 兜底（修复 #12）。

### Step 3：服务端 — 自动派生 xlsx 副本

修改 [src/lib/server/goalTaskRunner.ts L2522-2565](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskRunner.ts#L2522-L2565)（修复 #7：行号锚点修正）：

在 `files.map(persistFileArtifact)` 循环结束、生成 `artifactRefs` 之后追加：

```ts
const derivedXlsxRefs: ArtifactRef[] = [];
for (const file of files) {
  if (!file.filename.toLowerCase().endsWith(".md")) continue;
  try {
    const xlsxFilename = file.filename.replace(/\.md$/i, ".xlsx");
    const wb = markdownToWorkbook(file.content, { filename: xlsxFilename });
    if (!wb) continue;
    appendTrajectory({
      type: "system",
      status: "running",
      title: "正在派生 Excel 副本",
      thought: xlsxFilename,
    });
    const buffer = await buildXlsxBuffer(wb);
    const xlsxArtifact = persistFileArtifact({
      conversationId,
      taskId: input.task.id,
      instanceId: input.instance.id,
      runtimeJobId: `job-${input.instance.id}`,
      label: xlsxFilename,
      summary: "自动从 Markdown 表格派生的可编辑副本",
      filename: xlsxFilename,
      mime: XLSX_MIME,
      bytes: buffer,
    });
    derivedXlsxRefs.push(toArtifactRef(xlsxArtifact));
  } catch (error) {
    appendTrajectory({
      type: "system",
      status: "warning",
      title: "Excel 副本派生失败",
      thought: error instanceof Error ? error.message : String(error),
    });
  }
}
if (derivedXlsxRefs.length > 0) {
  result.taskResult.artifactRefs = [...(result.taskResult.artifactRefs ?? []), ...derivedXlsxRefs];
  result.structuredOutput = { ...(result.structuredOutput ?? {}), artifactRefs: result.taskResult.artifactRefs };
}
```

要点：
- 主流程从不因派生失败中断；
- `derivedXlsxRefs` 追加在 `.md ref` 之后，保证 .md 仍是首选展示项；
- artifactId 由 `persistFileArtifact` 保证全局唯一，**同名 base 不冲突**（修复 #10）。

### Step 4：前端 — `<TablePreview>`

新增 [src/components/spreadsheet/TablePreview.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/spreadsheet/TablePreview.tsx)（`"use client"`）：

```tsx
type Props = {
  data: TableData;
  variant?: "plain" | "with-toolbar"; // 默认 plain（修复 #1）
  filename?: string;                  // 单表下载时使用
};
```

- 视觉与现有 [BlockRenderer.tsx L61-85](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/execution/BlockRenderer.tsx#L61-L85) 完全一致（修复 #8）；
- `variant === "with-toolbar"` 时，右上角 hover 出现"下载 Excel"链接（遵循 Hover-to-show）；
- 点击下载：`await import("@/lib/spreadsheet/client/xlsxIo")` → `writeTableDataToBlob(data)` → `triggerBrowserDownload`；
- **得到的是单 sheet xlsx（无样式）**，与文件级派生 xlsx（多 sheet + 样式）形成清晰层级（修复 #4）。

### Step 5：前端 — `<SpreadsheetEditor>`

新增 [src/components/spreadsheet/SpreadsheetEditor.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/spreadsheet/SpreadsheetEditor.tsx)（`"use client"`）：

- Props：`{ artifact: ArtifactRef }`；
- 加载：`fetch(artifact.previewUrl).arrayBuffer()` → 动态 import xlsxIo → `parseXlsxArrayBuffer`；
- 多 sheet tab；每个单元格 `<input>` 直接编辑（极简：无边框；hover/focus 出现浅底色）；
- 「下载已填写版本」 → `writeWorkbookToBlob` + `triggerBrowserDownload(blob, artifact.label)`；
- 「重置」 → 重新 fetch 解析；
- 状态本地 `useState`，不接 zustand；不写回服务端。

### Step 6：替换/接入现有渲染入口

| 入口 | 改动 | 备注 |
|---|---|---|
| [BlockRenderer.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/execution/BlockRenderer.tsx) `case "comparison_table"` | 改为 `<TablePreview data={comparisonTableBlockToTable(block)} variant="with-toolbar" />` | 视觉零回归；新获得"下载 Excel" |
| [BlockRenderer.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/execution/BlockRenderer.tsx) `case "markdown"` | `<MarkdownRenderer content={block.content} tableVariant="with-toolbar" />` | 仅在结果区显式开启工具栏（修复 #1） |
| [MarkdownRenderer.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/common/MarkdownRenderer.tsx) | ① 解析逻辑外迁；② 新增 prop `tableVariant?: "plain" \| "with-toolbar"`，**默认 `"plain"`**；③ table block 委托 `<TablePreview data={...} variant={tableVariant} />` | 不破坏其它调用方 |
| [FileCard.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/execution/FileCard.tsx) | 当 `mime === XLSX_MIME` 或文件名以 `.xlsx` 结尾，卡片底部出现「展开为可编辑表格」按钮，点击渲染 `<SpreadsheetEditor>`（next/dynamic 懒加载） | 保留原"预览/下载" |

### Step 7：MarkdownRenderer 调用方排查

`MarkdownRenderer` 当前被两处使用：
- [ConversationMessageItem.tsx L155](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/conversation/ConversationMessageItem.tsx#L155)：会话气泡，**保持默认 plain**（避免气泡里冒出"下载 Excel"按钮）；
- [BlockRenderer.tsx L38-39](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/execution/BlockRenderer.tsx#L38-L39)：结果区 markdown block，**显式 `tableVariant="with-toolbar"`**。

---

## 五、文件变更清单

| 类型 | 路径 | 说明 |
|---|---|---|
| 修改 | [package.json](file:///Users/bytedance/Documents/trae/long_horizon_agent/package.json) | 新增 `exceljs`、`xlsx`、`server-only` |
| 新增 | `src/lib/spreadsheet/types.ts` | TableData / SpreadsheetWorkbook |
| 新增 | `src/lib/spreadsheet/constants.ts` | `XLSX_MIME` |
| 新增 | `src/lib/spreadsheet/adapters/cell.ts` | cellText / cellClassName |
| 新增 | `src/lib/spreadsheet/adapters/markdownTables.ts` | markdown → workbook |
| 新增 | `src/lib/spreadsheet/adapters/comparisonTableBlock.ts` | block → TableData |
| 新增 | `src/lib/spreadsheet/server/buildXlsx.ts` | exceljs（server-only） |
| 新增 | `src/lib/spreadsheet/client/xlsxIo.ts` | SheetJS 读/写 + triggerBrowserDownload |
| 新增 | `src/components/spreadsheet/TablePreview.tsx` | 通用表格 + 工具栏 |
| 新增 | `src/components/spreadsheet/SpreadsheetEditor.tsx` | xlsx 可编辑视图 |
| 修改 | [src/components/common/MarkdownRenderer.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/common/MarkdownRenderer.tsx) | 解析外迁；新增 tableVariant（默认 plain）；委托 `<TablePreview>` |
| 修改 | [src/components/execution/BlockRenderer.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/execution/BlockRenderer.tsx) | comparison_table → `<TablePreview variant="with-toolbar">`；markdown block 传 tableVariant；引用 cell util |
| 修改 | [src/components/execution/FileCard.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/execution/FileCard.tsx) | xlsx 文件接入 `<SpreadsheetEditor>` |
| 修改 | [src/lib/server/goalTaskRunner.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskRunner.ts) | L2522-2565 区段后追加派生逻辑 |

未涉及：types/kiki.ts、types/taskResult.ts、prompt fragments、agent 角色 prompt、API 路由。

---

## 六、设计决策与假设

1. **统一中间表示**：`TableData` 是唯一接口；新增导出（CSV/JSON）只在工具模块加方法。
2. **server / client 物理隔离**：`buildXlsx` 用 `server-only` 强制；`xlsxIo` 仅 dynamic import。
3. **MarkdownRenderer 默认 plain**：避免污染会话气泡等通用调用方；显式 opt-in 才出工具栏。
4. **单表 vs 文件级 xlsx 语义清晰**：
   - 工具栏（前端 SheetJS）= 当前一张表 + 无样式 + 即时；
   - FileCard（服务端 exceljs）= 全部 sheet + 表头加粗 / 底色 + 历史模板。
5. **不改 prompt 协议、不写回服务端**：与前版一致。
6. **派生失败仅 warning trajectory，主流程不阻塞**。
7. **历史 .md 不迁移**：仅对新执行任务生效。
8. **依赖体积**：`exceljs` 仅服务端；`xlsx` 仅在用户主动展开/下载时按需加载，不进首屏 chunk。

---

## 七、验证步骤

1. **类型与构建**：`pnpm build`、`pnpm lint` 通过。
2. **Bundle 体积**：`next build` 输出确认客户端 chunk 不含 `exceljs`；`xlsx` 仅在按需 chunk。
3. **回归 — 视觉零差异**：
   - `comparison_table` 视觉与改前一致；hover 显出"下载 Excel"，点击得到合法单 sheet xlsx；
   - 含 GFM 表格的 markdown block 视觉一致；hover 显出工具栏；
   - 会话气泡 markdown 表格 **不**显示工具栏。
4. **xlsx 派生**：复跑护照签证清单任务 → FileCard 同时出现 `passport_visa_checklist.md` 与 `passport_visa_checklist.xlsx`；下载后用 Excel/Numbers 打开 → 表头加粗 + 浅蓝底色，2 张 sheet（清单 + 核对统计），列宽合理。
5. **可编辑预览**：「展开为可编辑表格」 → 修改单元格 → 「下载已填写版本」 → 验证编辑生效；中文文件名下载正常；「重置」回模板。
6. **降级**：纯文本 .md 不派生；伪表格（缺分隔行）跳过；极端长表头/单列/空行不抛错。
7. **派生失败保护**：mock `buildXlsxBuffer` 抛错 → trajectory warning，主任务正常 completed。
8. **Trace 现场**：Dev Panel 见「正在派生 Excel 副本」、「已生成文件产物」事件；不污染原始 stdin/stdout。

---

## 八、范围外（不做）

- 不放宽 agent 的 `FILE_ARTIFACT_PROMPT_FRAGMENT` 扩展名白名单；
- 不开放 xlsx 服务端写回 API；
- 不引入 handsontable / react-spreadsheet；
- 不改 `TaskExpectedResult.exportableFormats` 与 `FileArtifactKind` 枚举；
- 不更新历史 `.md` 产物；
- `KeyValueBlock` 适配器先不实现（标记为可扩展点）；
- 不做 xlsx → markdown 反向同步。

---

## 九、修订记录（v2.1 自检修复）

| # | 问题 | 修复 |
|---|---|---|
| 1 | MarkdownRenderer 在会话气泡等场景被复用，默认开工具栏会污染 | 新增 `tableVariant`，默认 `"plain"`，仅 BlockRenderer 显式开启 |
| 2 | 误以为 SheetJS Community 能写样式 | 选型说明：服务端 exceljs（带样式），客户端 SheetJS（仅值） |
| 3 | server/client 边界没物理强制 | 服务端模块 `import "server-only";`；客户端走 dynamic import |
| 4 | 单表下载 vs 文件级下载语义易混 | 工具栏 = 单 sheet 即时导出；FileCard = 全 sheet + 样式 |
| 5 | highlight 仅 comparison_table 有 | TableData.highlight 设为可选；其他 adapter 不填 |
| 6 | 历史 .md 没有 .xlsx | 文档显式说明仅对新任务生效，不做迁移 |
| 7 | runner 落盘行号锚点错误 | 修正为 [L2522-2565](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskRunner.ts#L2522-L2565) |
| 8 | comparison_table 容器外框需保留 | TablePreview 输出与原 BlockRenderer 完全一致的 className |
| 9 | TablePreview 工具栏不能 import 服务端 buildXlsx | 改为 SheetJS 客户端单表导出 |
| 10 | 同名文件冲突未说明 | artifactId 全局唯一，物理路径无冲突 |
| 11 | 异常 markdown 降级未说明 | adapter 返回 null / 跳过该表；空 workbook 抛错由调用方吞 |
| 12 | 中文/特殊字符文件名下载 | `triggerBrowserDownload` 用 Blob URL + `<a download>`，filename 做 encode 兜底 |

# KiKi Design System

> 当前文档基于项目现有 UI 与代码实现整理，用于指导后续新页面、新组件和交互产物的设计与开发。它不是一套外部引入的 UI Kit，而是从当前产品中沉淀出的视觉语言、组件模式与交互约定。

## 1. 设计定位

KiKi 是一个面向长耗时任务、目标规划、多形态产物和本地运行环境的智能工作台。UI 需要同时支持：

- 快速输入与命令触发。
- 长任务的状态可见、过程可追踪、随时可停止。
- 任务结果的双区域呈现：交互渲染区与文件区域并列。
- 会话、目标、任务、产物之间的上下文跳转。
- 安全隔离的可执行小应用、外部嵌入与文件产物。

设计气质应保持「轻量、克制、可操作、低干扰」。默认不要做重装饰，不要把界面做成强品牌视觉；优先让状态、动作和结果清晰。

## 2. 设计原则

### 2.1 极简直观

- 页面信息密度可以高，但视觉层级必须清楚。
- 默认使用白色卡片、浅灰背景、细边框和少量强调色。
- 避免大面积渐变、复杂阴影和装饰性插画。
- 操作入口应贴近用户当前上下文，不让用户跨区域寻找动作。

### 2.2 状态优先

- 长耗时任务的状态必须始终可见。
- `进行中`、`等待用户`、`已暂停`、`已完成`、`失败/未通过验收` 等状态要用统一文案和统一徽标表达。
- 所有运行中任务都应提供明确的停止或暂停入口。
- 用户需要确认、作答、补充上下文时，卡片必须显式标记。

### 2.3 结果可操作

- 结果不是纯文本，应优先组织成可扫读、可跳转、可预览、可下载、可交互的结构。
- 交互渲染区用于动态表单、webapp、结构化 blocks。
- 文件区域用于报告、附件、导出文件、外链资源。
- 文件产物是结果的附加项，不应替代交互渲染区。

### 2.4 安全隔离

- 内部 `webapp` 小应用必须运行在受限 iframe 中。
- 第三方视频或页面使用独立外部嵌入模式，不与内部 webapp 混用。
- 联网小应用必须通过受控代理访问互联网，不直接开放宿主能力。

## 3. 技术基础

当前项目的样式体系以 Tailwind CSS 为主：

- Tailwind 原子类直接写在组件中。
- `cn()` 负责条件类名合并，来源：`src/lib/utils.ts`。
- 全局样式集中在 `src/app/globals.css`。
- Tailwind 配置位于 `tailwind.config.ts`。
- 图标使用 `lucide-react`。
- 字体使用本地 Geist，并回退到系统无衬线字体。

当前没有集中式基础组件库，也没有使用 shadcn、MUI、Ant Design 或 CSS-in-JS。未来新增 UI 应优先复用现有组件模式，逐步抽象基础组件，而不是引入新的视觉体系。

## 4. 视觉 Token

### 4.1 全局颜色

当前全局变量：

```css
:root {
  --background: #f5f6f8;
  --foreground: #1f2328;
}
```

推荐将现有颜色归并为以下语义 token：

| Token | 当前色值 | 用途 |
| --- | --- | --- |
| `background.app` | `#F5F6F8` | 应用整体背景 |
| `background.surface` | `#FFFFFF` | 卡片、抽屉、弹窗、输入区 |
| `background.subtle` | `#F6F8FA` | hover、浅色区块、次级按钮 hover |
| `background.info` | `#F4F8FF` | 文件图标底、信息提示 |
| `text.primary` | `#1F2328` | 标题、主要正文 |
| `text.body` | `#374151` | 正文摘要 |
| `text.secondary` | `#6B7280` | 辅助说明 |
| `text.muted` | `#8C9198` | 元信息、时间、类型 |
| `border.default` | `#E5E7EB` | 默认边框 |
| `border.strong` | `#D0D7DE` | hover 边框、分隔符 |
| `focus.ring` | `#D0D7DE` | 焦点环 |
| `brand.dark` | `#1F2328` | 主按钮背景 |
| `brand.hover` | `#374151` | 主按钮 hover |
| `danger.text` | `#B42318` | 停止、删除、错误动作 |
| `danger.border` | `#FECACA` | 危险动作边框 |
| `warning.bg` | `#FFF3CD` | 需要确认、需要作答徽标 |
| `warning.text` | `#8A6D3B` | warning 徽标文字 |
| `link.blue` | `#0D47A1` | 文件、外链、信息类强调 |

使用建议：

- 新 UI 禁止随意新增相近灰色，应优先从上表选择。
- 状态色必须语义化，不要只按视觉喜好选择颜色。
- 如果需要新增颜色，先判断是否是领域 token，例如日程事件颜色可保留在 `src/components/schedule/colorTokens.ts`。

### 4.2 字体

全局字体：

```css
font-family: var(--font-geist-sans), ui-sans-serif, -apple-system, BlinkMacSystemFont, "SF Pro", "PingFang SC", system-ui, sans-serif;
```

推荐字号：

| 场景 | Tailwind 写法 | 说明 |
| --- | --- | --- |
| 页面标题 | `text-xl` / `text-2xl` | 页面主标题 |
| 卡片标题 | `text-[15px] font-semibold` | 任务卡片、结果卡片标题 |
| 常规正文 | `text-sm` / `text-[13px]` | 摘要、说明、正文 |
| 元信息 | `text-[12px]` | 状态、时间、类型、chip |
| 按钮文字 | `text-[12px]` / `text-sm` | 根据按钮尺寸选择 |

排版建议：

- 标题使用 `font-semibold` 或 `font-medium`，避免过重字重。
- 摘要文本常用 `leading-5` 或 `leading-6`。
- 长摘要限制为 2 行，例如 `line-clamp-2`。

### 4.3 圆角

| 场景 | 推荐值 |
| --- | --- |
| 大卡片、任务卡片、文件卡片 | `rounded-xl` |
| 输入框、次级按钮、图标底 | `rounded-lg` |
| 小按钮、危险按钮 | `rounded-md` |
| 状态徽标、chip | `rounded-full` |

使用建议：

- 默认卡片使用 `rounded-xl`。
- 表单输入使用 `rounded-lg`。
- 不建议混用过大的 `rounded-2xl`，除非用于非常独立的 Hero 或大型面板。

### 4.4 间距

推荐间距规则：

| 场景 | 推荐值 |
| --- | --- |
| 卡片内边距 | `p-4` / `p-5` |
| 卡片之间 | `mt-3` / `gap-3` |
| 标题与元信息 | `mt-1` |
| 元信息与摘要 | `mt-2` |
| 操作区与内容 | `mt-3` / `mt-4` |
| 图标与文字 | `gap-1.5` / `gap-2` |
| 主体 flex 间距 | `gap-3` |

### 4.5 边框与阴影

默认视觉层级：

- 应用背景：浅灰。
- 面板和卡片：白底 + 细边框。
- hover：边框变深，必要时加极轻阴影。
- 强阴影默认禁用。

推荐写法：

```tsx
className="rounded-xl border border-[#E5E7EB] bg-white"
```

轻阴影只用于可点击结果卡片或文件卡片：

```tsx
className="shadow-sm"
className="shadow-[0_6px_18px_rgba(15,23,42,0.03)]"
```

## 5. 布局系统

### 5.1 应用壳层

核心布局由 `AppShell` 承载：

- 左侧 `Sidebar` 是固定导航区。
- 右侧 `AssistantSidebar` 可开启，并挤压主内容。
- 任务详情与任务结果抽屉通常是覆盖式，不挤压主内容。
- 特定路由可进入沉浸式内容区。

设计新页面时应遵守：

- 不要绕过 `AppShell` 自建全局布局。
- 主内容区应适配左侧栏收起和展开状态。
- 右侧助手开启时，主内容应保留可读宽度。
- 结果抽屉优先覆盖，不要与右侧助手产生层级冲突。

### 5.2 双侧栏协同

现有侧栏关系：

| 区域 | 行为 |
| --- | --- |
| 左导航 | 展开/收起，全局 store 管理 |
| 右助手 | 打开时挤压主内容 |
| 任务抽屉 | 覆盖主内容，可临时收起左侧栏 |
| 全屏结果页 | 复用结果主体结构，减少抽屉空间限制 |

### 5.3 内容容器

新页面建议采用：

- 列表页：浅灰背景 + 白色列表卡片。
- 详情页：白色主体卡片 + 右侧或顶部操作区。
- 结果页：结构化结果块 + 产物区域。
- 任务型页面：顶部上下文标题 + 中部状态/任务流 + 右侧或抽屉详情。

## 6. 组件模式

### 6.1 按钮

主要按钮：

```tsx
className="inline-flex items-center gap-1.5 rounded-lg bg-[#1F2328] px-3 py-1.5 text-[12px] text-white hover:bg-[#374151]"
```

次级按钮：

```tsx
className="inline-flex items-center gap-1.5 rounded-lg border border-[#D0D7DE] px-3 py-1.5 text-[12px] text-[#1F2328] hover:bg-[#F6F8FA]"
```

危险按钮：

```tsx
className="rounded-md border border-[#FECACA] bg-white px-3 py-1.5 text-[12px] text-[#B42318] hover:border-[#B42318]"
```

按钮规范：

- 按钮应表达动词，例如「预览」「下载」「停止执行」「重新执行」。
- 运行中任务必须出现「停止」类动作。
- 危险动作默认不要使用纯红底，优先红色文字 + 红色浅边框。
- 图标按钮必须有 hover 态和可访问标签。

### 6.2 输入框

全局 `.input`：

```css
@apply w-full rounded-lg border border-[#E5E7EB] px-3 py-2 text-sm text-[#111] outline-none transition focus:border-[#111];
```

全局 `.textarea`：

```css
@apply min-h-24 w-full rounded-lg border border-[#E5E7EB] px-3 py-2 text-sm text-[#111] outline-none transition focus:border-[#111];
```

输入规范：

- 表单输入优先复用 `.input` 和 `.textarea`。
- 命令输入、聊天输入可自定义，但应保持圆角、浅边框、聚焦反馈一致。
- 禁用态必须提供明确原因或替代动作。

### 6.3 卡片

任务消息卡片是当前最重要的卡片范式：

```tsx
className="mt-3 w-full cursor-pointer rounded-xl border border-[#E5E7EB] bg-white p-5 text-left transition hover:border-[#D0D7DE] hover:shadow-sm focus:outline-none focus:ring-2 focus:ring-[#D0D7DE]"
```

卡片规范：

- 任务卡片必须整张可点击。
- 可点击卡片必须支持键盘访问，至少支持 `Enter` 和 `Space`。
- 卡片标题、元信息、摘要三层结构应保持一致。
- 右上或右侧放置当前上下文最重要动作。
- 内部按钮点击要阻止冒泡，避免误触打开详情。

### 6.4 状态徽标与 Chip

常见状态：

| 状态 | 文案 |
| --- | --- |
| 完成 | `已完成` |
| 运行中 | `进行中` |
| 等待用户确认 | `待确认` / `需要确认` |
| 等待用户作答 | `待作答` / `需要作答` |
| 等待补充上下文 | `待补充` |
| 线下动作 | `待线下完成` |
| 暂停 | `已暂停` |
| 验收失败 | `未通过验收` |

徽标规范：

- 状态徽标使用小字号 `text-[12px]`。
- 需要用户介入的徽标使用 warning 背景：`bg-[#FFF3CD] text-[#8A6D3B]`。
- 产物摘要使用 chip 聚合表达，例如 webapp、external embed、files。

### 6.5 弹窗与抽屉

弹窗：

- 用于删除确认、设置、轻量表单。
- 默认白底、细边框、圆角、弱阴影。
- 文案必须明确后果。

抽屉：

- 用于任务详情、任务结果、目标计划。
- 右侧覆盖式为默认。
- 顶部包含标题、上下文路径、关闭按钮，必要时提供全屏入口。
- 中部滚动，底部操作固定或跟随内容，按复杂度选择。

### 6.6 列表行

列表行适用于任务列表、会话列表、收件箱列表：

- 主点击区域打开详情。
- 左侧展示状态点、图标或类型。
- 中部展示标题、摘要、元信息。
- 右侧操作默认隐藏，hover 时显示。
- 支持更多菜单或右键菜单。

## 7. 核心产品模式

### 7.1 命令模式

`/goal` 是当前重要输入范式：

- Slash command 以胶囊或菜单方式降低发现成本。
- 输入框应支持键盘导航：上、下、回车、ESC。
- Backspace 可取消已选命令。
- 任务运行或禁用时，输入区域应显示停止或受限提示。

未来新增命令：

- 命令名要短。
- 命令描述要说明产出。
- 命令选择后要让用户知道当前处于什么模式。

### 7.2 任务卡片

任务卡片承担会话中的「结果入口」：

- 标题：包含任务名或实例标题。
- 元信息：执行类型、状态、用户介入标记、产物摘要。
- 摘要：最多两行，优先展示用户需要知道的结果或下一步。
- 操作：运行中显示停止按钮。
- 点击：打开右侧结果抽屉。

设计要求：

- 不要只让局部按钮可点击，整张卡片都应可进入结果。
- 等待用户输入时，应在卡片下方直接展示交互面板。
- 已提交交互后，应展示提交摘要，避免用户重复操作。

### 7.3 任务结果

任务结果采用「过程 + 结果 + 产物」结构：

- 任务信息：期望产出、最近更新、重试/停止。
- 执行链路：时间线、工具调用、错误、日志摘要。
- 交互渲染区：blocks、webapp、动态表单等。
- 文件区域：文件、链接、下载、预览。

结果设计要求：

- 交互渲染区优先于文件区域。
- 文件产物必须可预览或下载。
- 外链必须显示目标 host 或安全提示。
- 长结果应分块，不要直接输出超长纯文本。

### 7.4 产物呈现

文件卡片结构：

- 左侧文件图标。
- 标题。
- 类型和大小。
- 摘要。
- 操作：预览、下载。

链接卡片结构：

- 标题或 URL。
- host 或类型。
- 打开外链。

WebApp 产物：

- 使用 iframe 承载。
- 显示加载、错误、重载状态。
- 支持高度上报与状态持久化。

外部嵌入：

- 独立 `ExternalEmbedSurface`。
- 提供新窗口打开兜底。
- 不复用内部 webapp 的安全模型。

### 7.5 结构化结果块

通用 blocks 可用于报告型结果：

- 标题。
- 段落。
- Markdown。
- 列表。
- 键值。
- 对比表。
- 决策。
- 提示框。

设计要求：

- blocks 顺序要表达阅读路径。
- 决策和下一步要显著，但不要使用强侵入样式。
- 提示框应按语义区分信息、警告、成功、错误。

## 8. 交互规范

### 8.1 可点击区域

- 卡片类入口应整卡可点。
- 行类入口应整行可点。
- 内部操作按钮要阻止父级点击。
- 可点击元素必须有 hover 态。
- 重要卡片应有 focus ring。

### 8.2 Hover 显隐操作

适用场景：

- 会话列表项。
- 任务行。
- 收件箱列表。
- 结果块内的次级操作。

规范：

- 默认隐藏低频操作，hover 时显示。
- 高频动作可常驻。
- 不要让用户必须 hover 才能发现关键动作，例如停止任务。

### 8.3 键盘访问

必须支持：

- `Enter` 和 `Space` 打开卡片或行详情。
- `ESC` 关闭侧栏、抽屉、菜单。
- Slash command 菜单支持方向键。
- 输入提交支持合理快捷键。

### 8.4 加载与错误

加载：

- 短加载可用轻量文字或 skeleton。
- iframe 或外部嵌入必须显示加载提示。
- 后台长任务要展示状态，而不是全屏 loading。

错误：

- 错误应可恢复，提供重试、打开设置、查看日志等动作。
- 运行环境错误与普通任务错误要区分。
- 不要只显示红色错误文本，应说明用户下一步可以做什么。

### 8.5 停止与取消

长耗时任务必须满足：

- 运行中卡片显示停止入口。
- 任务详情或结果抽屉显示停止入口。
- 停止动作反馈成功或失败。
- 如果停止失败，要展示错误原因。

## 9. 安全与嵌入规范

### 9.1 内部 WebApp

内部小应用必须遵守：

- iframe sandbox 只允许 `allow-scripts`。
- 严禁增加 `allow-same-origin`。
- 小应用不能直接访问宿主 DOM、Cookie 或内部 API。
- 状态通过受控 postMessage 协议同步。

### 9.2 联网 WebApp

联网小应用必须遵守：

- CSP 默认限制直接联网。
- 只能通过 `KikiBridge.fetchInternet()` 访问公网。
- 服务端代理必须阻断 localhost、内网 IP、非 HTTPS 请求。

### 9.3 外部嵌入

外部嵌入适用于：

- YouTube。
- 第三方网页。
- 不受内部 webapp 安全模型控制的资源。

规范：

- 使用独立外部嵌入组件。
- 显示来源 host。
- 提供新窗口打开兜底。
- 不要把外部嵌入伪装成内部小应用。

## 10. 页面类型指南

### 10.1 会话页

结构：

- 顶部标题与目标规划入口。
- 中部消息流。
- 消息中可嵌入任务卡片。
- 底部命令输入框。
- 右侧结果抽屉。

新增设计应确保：

- 任务结果入口稳定可见。
- 任务卡片有 `taskSnapshot` 兜底时也能打开。
- 输入区和消息流不被右侧栏遮挡。

### 10.2 目标任务页

结构：

- 目标上下文。
- 子目标块。
- 任务列表行。
- 任务详情抽屉。
- 执行动作与更多菜单。

新增设计应确保：

- 任务状态点统一。
- 行点击与操作按钮不冲突。
- 暂停、继续、执行、重试动作表达一致。

### 10.3 收件箱

结构：

- 消息卡片列表。
- 未读红点。
- 时间标签。
- 展开后展示任务或行动建议。
- 可跳转任务结果。

新增设计应确保：

- 需要作答或确认的信息高亮。
- 摘要可快速判断是否需要处理。
- 展开内容不要过长，复杂内容跳转结果抽屉。

### 10.4 日程页

日程模块可保留领域 token：

- 事件颜色来自 `src/components/schedule/colorTokens.ts`。
- 时间网格、全天栏、事件块属于领域组件。
- 不强制套用任务卡片样式，但基础颜色、边框、字体仍应一致。

## 11. 代码组织建议

当前状态：

- 样式散落在功能组件中。
- 只有 `.input`、`.textarea` 是全局复用类。
- `cn()` 已可作为条件样式基础。
- 颜色 token 尚未系统化。

建议演进路径：

### 11.1 第一阶段：冻结规范

- 保留当前 Tailwind 写法。
- 新 UI 按本文档选择颜色、字号、圆角、间距。
- 禁止无理由新增灰阶、阴影和圆角体系。

### 11.2 第二阶段：抽基础组件

优先抽象：

- `Button`
- `IconButton`
- `Input`
- `Textarea`
- `Badge`
- `Card`
- `Drawer`
- `Dialog`
- `Menu`
- `StatusDot`

组件应支持：

- `variant`
- `size`
- `disabled`
- `className`
- `children`

### 11.3 第三阶段：Token 化

将常用色值迁移到：

- CSS variables。
- `tailwind.config.ts` theme extension。
- 必要时增加 TypeScript token 文件。

建议 token 命名：

```ts
surface
surfaceMuted
border
borderHover
textPrimary
textSecondary
textMuted
focusRing
danger
warning
info
```

### 11.4 第四阶段：沉淀示例页

建议新增内部设计样例页或 Storybook 替代方案：

- 按钮状态。
- 表单状态。
- 卡片状态。
- 任务状态。
- 抽屉与弹窗。
- 产物渲染。
- WebApp sandbox 示例。

## 12. 新 UI 设计检查清单

设计新 UI 前检查：

- 是否使用了现有背景、文字、边框颜色？
- 是否避免了无必要强阴影和强装饰？
- 是否有清晰的状态表达？
- 长任务是否提供停止入口？
- 卡片或列表行是否整块可点击？
- hover、focus、disabled 状态是否完整？
- 是否支持键盘访问和 ESC 关闭？
- 任务结果是否区分交互渲染区和文件区域？
- 文件产物是否可预览或下载？
- webapp 是否遵守 sandbox 与联网代理限制？
- 外部嵌入是否使用独立模式并提供兜底打开？
- 新增样式是否可复用，是否值得抽象为组件或 token？

## 13. 关键源码参考

| 类型 | 文件 |
| --- | --- |
| 全局样式 | `src/app/globals.css` |
| Tailwind 配置 | `tailwind.config.ts` |
| 字体与根布局 | `src/app/layout.tsx` |
| 类名合并工具 | `src/lib/utils.ts` |
| 应用壳层 | `src/components/layout/AppShell.tsx` |
| 左侧导航 | `src/components/layout/Sidebar.tsx` |
| 助手输入 | `src/components/layout/AssistantComposer.tsx` |
| 助手侧栏 | `src/components/layout/AssistantSidebar.tsx` |
| 会话页 | `src/components/conversation/ConversationView.tsx` |
| 任务消息卡片 | `src/components/conversation/TaskMessageCard.tsx` |
| 任务列表行 | `src/components/goal/TaskRow.tsx` |
| 任务结果抽屉 | `src/components/task/TaskResultDrawer.tsx` |
| 任务结果主体 | `src/components/task/ExecutionResultBody.tsx` |
| 结构化结果块 | `src/components/execution/BlockRenderer.tsx` |
| 产物渲染 | `src/components/execution/ArtifactRenderer.tsx` |
| 文件卡片 | `src/components/execution/FileCard.tsx` |
| 链接卡片 | `src/components/execution/LinkCard.tsx` |
| 内部 WebApp | `src/components/execution/SandboxedWebAppSurface.tsx` |
| 外部嵌入 | `src/components/execution/ExternalEmbedSurface.tsx` |
| 日程颜色 token | `src/components/schedule/colorTokens.ts` |

## 14. 推荐默认模板

### 14.1 标准卡片

```tsx
<div className="rounded-xl border border-[#E5E7EB] bg-white p-5">
  <div className="text-[15px] font-semibold text-[#1F2328]">标题</div>
  <div className="mt-1 text-[12px] text-[#8C9198]">元信息</div>
  <div className="mt-2 text-[13px] leading-6 text-[#374151]">摘要内容</div>
</div>
```

### 14.2 可点击任务卡片

```tsx
<div
  role="button"
  tabIndex={0}
  className="w-full cursor-pointer rounded-xl border border-[#E5E7EB] bg-white p-5 text-left transition hover:border-[#D0D7DE] hover:shadow-sm focus:outline-none focus:ring-2 focus:ring-[#D0D7DE]"
>
  <div className="text-[15px] font-semibold text-[#1F2328]">任务标题</div>
  <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-[#8C9198]">
    <span>Agent 任务</span>
    <span className="text-[#D0D7DE]">/</span>
    <span>进行中</span>
  </div>
  <div className="mt-2 line-clamp-2 text-[13px] leading-6 text-[#374151]">任务摘要</div>
</div>
```

### 14.3 文件产物卡片

```tsx
<div className="rounded-xl border border-[#E5E7EB] bg-white p-4 shadow-[0_6px_18px_rgba(15,23,42,0.03)]">
  <div className="flex items-start gap-3">
    <div className="mt-0.5 rounded-lg bg-[#F4F8FF] p-2 text-[#0D47A1]">icon</div>
    <div className="min-w-0 flex-1">
      <div className="truncate text-[14px] font-medium text-[#1F2328]">文件名</div>
      <div className="mt-1 text-[12px] text-[#8C9198]">类型 / 大小</div>
      <div className="mt-2 text-[13px] leading-5 text-[#6B7280]">文件摘要</div>
    </div>
  </div>
</div>
```


# 日程页实现计划（v1 空态 + v2 日/周/月三视图）

## 摘要

* 本次实现宿主产品 Dora 下的子页面 `/schedule`，按 PRD v4 分两步落地：

  * v1 空态：仅渲染一张符合规范的虚线空态卡片

  * v2+ 完整形态：日 / 周 / 月三视图 + 查看 / 创建 / 修改 / 删除 + localStorage 持久化

* 作为宿主的子页面，不重绘左侧导航和底部全局输入框；仅替换 `AppShell` 中间主内容槽位

* 与宿主既有视觉、色彩、字体、圆角保持一致，严格禁止 `box-shadow`

## 当前状态分析

* 路由：`src/app/schedule/page.tsx` 当前只有一句空态文案

* 宿主外壳：`src/components/layout/AppShell.tsx` 已提供三栏布局，其中：

  * 左栏由 `Sidebar`（`src/components/layout/Sidebar.tsx`）提供，`日程` 已是导航项并指向 `/schedule`

  * 底部由 `BottomComposer` 吸底，日程页需要避让

  * 右下角由 `DevPanel` 吸底浮层展示虚拟时钟，日程页也需要避让

* 技术栈：Next.js 14 App Router + React 18 + TypeScript + Tailwind + Zustand + React Query，未使用 dayjs、未使用 @dnd-kit

* 路径别名：`@/*` 指向 `src/*`

* 全局背景已是 `#F5F6F8`，字体栈、主色与 PRD 一致

* 目前 tailwind.config.ts 未扩展 PRD 要求的颜色 token，但宿主代码绝大多数地方是直接写十六进制色值，保持原风格即可（不新增全局 tailwind 扩展，避免污染既有页面）

* 中间主内容区容器宽度在 AppShell 中由 `max-w-5xl` 控制，日程页需要自身更宽的显示空间，需要在 `/schedule` 路由下重写外层容器（详见下方）

## 交付范围与边界

* 仅修改 `src/app/schedule/page.tsx` 以及新建日程模块目录

* 不修改左栏、底部输入框、Dev 浮层

* 不在 `AppShell` 中新增 schedule 专属条件分支；通过日程页自身的容器样式突破 `max-w-5xl` 的宽度限制

*- 直接落地 v2 完整形态（PRD 第九条明确要求三视图闭环），不保留 v1 空态组件

* 所有时间相关实现使用原生 `Date` + 自写小工具，**不引入 dayjs / @dnd-kit / timezone** 新依赖（保持 package.json 稳定；PRD 的技术栈建议在当前原型阶段以原生 API 等价实现即可）

## 目录结构与新增文件

```text
src/
├─ app/schedule/page.tsx                   # 入口页：渲染 <SchedulePage />
├─ components/schedule/
│  ├─ SchedulePage.tsx                     # 顶层壳：Header + 视图切换 + 当前视图
│  ├─ ScheduleHeader.tsx                   # 今天/左右/日期标题/视图切换/新建按钮/头像
│  ├─ WeekView.tsx                         # 周视图
│  ├─ DayView.tsx                          # 日视图
│  ├─ MonthView.tsx                        # 月视图
│  ├─ EventBlock.tsx                       # 周/日视图事件块
│  ├─ AllDayBar.tsx                        # 全天事件折叠条
│  ├─ CurrentTimeLine.tsx                  # 红色当前时间线
│  ├─ EventPopover.tsx                     # 详情 Popover（含删除二次确认）
│  ├─ EventFormDialog.tsx                  # 创建/编辑表单（Modal）
│  ├─ colorTokens.ts                       # 事件色板 + 视觉常量
│  └─ timeGrid.ts                          # 时间网格工具（像素 <-> 分钟 转换、半小时刻度）
├─ stores/scheduleStore.ts                 # Zustand + localStorage 持久化
├─ mocks/schedule.ts                       # 预置示例事件（全天/跨天/普通/取消/多人/Agent）
└─ types/schedule.ts                       # AgentEvent / Attendee 类型
```

## 数据模型（types/schedule.ts）

严格按 PRD 第六节：

```ts
export type AgentEventColor = "blue" | "green" | "purple" | "pink" | "orange" | "cyan";

export interface Attendee {
  id: string;
  name: string;
  email?: string;
  avatarUrl?: string;
}

export interface AgentEvent {
  id: string;
  title: string;
  description?: string;
  startTime: string; // ISO 8601
  endTime: string;
  isAllDay: boolean;
  attendees: Attendee[];
  color?: AgentEventColor;
  location?: string;
  status?: "normal" | "cancelled";
  createdByAgent: boolean;
  agentActions?: Array<{
    label: string;
    type: "primary" | "secondary";
    payload?: Record<string, unknown>;
  }>;
}
```

## 状态管理（stores/scheduleStore.ts）

* Zustand store，字段：`events: AgentEvent[]`、`focusDate: string`（ISO 日期）、`viewMode: "day" | "week" | "month"`

* 操作：`setFocusDate`、`setViewMode`、`goToToday`、`prev`、`next`、`addEvent`、`updateEvent`、`deleteEvent`、`cancelEvent`

* `prev / next` 按当前 `viewMode` 自动切换步长（日 = 1 天、周 = 7 天、月 = 1 个月）

* 持久化：

  * 初始化时从 `localStorage.getItem("kiki.schedule.events")` 读取

  * `events` 任意变更后写回

  * 仅持久化 `events`，`focusDate / viewMode` 存在 store 内存即可（刷新后回到 `useVirtualClock` 当前时间所在日）

* SSR 兼容：store 内部访问 `window` 前做 `typeof window !== "undefined"` 判断

* `events` 的初始值：若 localStorage 为空，则使用 `mocks/schedule.ts` 的示例数据 seed

## 预置示例数据（mocks/schedule.ts）

围绕宿主虚拟时间 `BASE_DATE = 2026-04-26 10:00 +08:00` 所在周，构造 6\~8 条事件：

1. 全天事件（橙色）：`2026-04-27` 全天 "托福考试 110 分 · 学习冲刺日"
2. 跨天事件（紫色）：`2026-04-29 09:00 ~ 2026-04-30 18:00` "大阪 6 日游 · 行前准备"
3. 普通事件（蓝色）：`2026-04-28 10:00 ~ 11:00` "听力练习反馈会"
4. 普通事件（绿色）：`2026-04-28 14:30 ~ 15:30` "单词背诵复盘"，多参与人
5. 取消事件（粉色）：`2026-04-29 16:00 ~ 17:00` "AI 产品经理面试准备"，`status = cancelled`
6. Agent 建议（青色）：`2026-04-30 09:00 ~ 11:00` 专注时段，`createdByAgent = true`，`agentActions` 包含主/次按钮
7. 日视图高亮示例（橙色）：`2026-04-26 13:00 ~ 15:00` 专注时段，供日视图展示米黄高亮时段
8. 短时相邻事件（蓝/绿，用于测试并排）：`2026-04-28 10:30 ~ 11:30` 与第 3 条部分重叠

## 页面结构与关键组件

### app/schedule/page.tsx

* 仅负责挂载：`return <SchedulePage />;`

* 因为 `AppShell` 内部将 children 放入 `max-w-5xl`，日程页需要更大的显示宽度：在 `<SchedulePage />` 顶层使用 `className="-mx-auto w-full max-w-none"` 思路行不通，因此改为：

  * 在 `SchedulePage` 最外层加 `<div className="w-full max-w-[1280px] mx-auto">`

  * 不修改 `AppShell`，因为 `max-w-5xl` 在大屏下足够放下 7 列周视图（已复核：`max-w-5xl = 1024px`，PRD 第九条要求 1280×800 无横向滚动条；为达标，此处改为直接在 `SchedulePage` 用 `className="w-full"`，并用 CSS 把容器 `max-width: none`）。

  * 落地方案：`app/schedule/page.tsx` 输出 `<div className="-mx-4 lg:mx-0"> <SchedulePage /> </div>`，并在 `SchedulePage` 内部用 `w-full` 填满；同时 AppShell 的 `max-w-5xl` 在 1280 视口下实际是 1024，外层还留有 padding，`SchedulePage` 通过自己内部的卡片 `px` 来控制即可，列宽由剩余空间均分，不强求 1280（与 PRD 的"1280×800 无横向滚动条"可通过减少列内边距来实现，实际验证以 1280 宽窗口无 x 方向滚动即可）

* 结论：不改 AppShell，日程页组件在宿主给定的区域内自适应

### SchedulePage

* 顶层结构：

  * 外层白卡：`bg-white border border-[#E5E7EB] rounded-xl`，`p-0`

  * 内部分为：`ScheduleHeader`（高 56）+ 当前视图内容 + 底部 `pb-24` 内边距用于避让底部输入框

* 根据 `viewMode` 分发 `<DayView /> | <WeekView /> | <MonthView />`

* 处理键盘快捷：左右方向键触发 `prev/next`，`T` 键触发 `goToToday`（只在 body focus 时）

### ScheduleHeader

* 左区：

  * `今天` 次级按钮 → `goToToday()`

  * `← / →` 图标按钮 → `prev() / next()`

  * 日期标题：根据 `viewMode` 渲染（周：`2026年5月3日 - 9日` / 日：`2026年5月6日` / 月：下方 28px 加粗大字，Header 仅显示年份或省略）

* 右区：

  * `日 / 周 / 月` 胶囊分段控件，选中态：浅灰底 `#F5F6F8` + 加粗

  * `+ 新建日程` 按钮，主按钮样式

  * `JJ` 浅灰头像 28px（与宿主 UserMenu 头像视觉一致，但这里只作为装饰，不触发菜单）

### WeekView

* 7 列 + 左侧 56px 时间刻度

* 顶部列头：两行（星期名 + 日期数字），当天数字 `#3370FF`

* 顶部「全天」折叠条（AllDayBar）：可 `∧/∨` 折叠，跨天事件横向拉通

* 时间网格：

  * 整点实线 1px `#E5E7EB`，半小时虚线 `#EFF1F4`

  * 每小时高度固定为 48px（白天 24 \* 48 = 1152px，容器可滚动）

* 当前时间线 `CurrentTimeLine`：1px `#E5484D` + 左端 8px 圆点 + 左侧刻度位置替换为红色时间文字

* 事件块 `EventBlock`：

  * 圆角 6、无阴影、左侧 3px 彩条

  * 浅底 + 同色深字；两行（标题 + 时间），可选第三行地点

  * 取消态：虚线边框 + 删除线 + 0.6 透明度

  * 重叠：当同一列多条时间交叉时，平分列宽，间距 2px

* 默认滚动到 `8 AM`；切到 `今天` 时滚动到当前时间线

### DayView

* 单列大格 + 左 56px 刻度

* 头部：左上 GMT+8，中央 `周三 6`，`6` 为红底白字胶囊；两侧 `+` 图标按钮预留扩展

* 高亮时段：针对 `agentActions` 带 `type=primary`（即 Agent 建议）且当日的事件，渲染一条浅米黄色带 `#FBF4D8` 覆盖其时间段

* 当前时间线：红底白字胶囊 `5:33PM`（圆角 4，padding 2/6）

* 全天区同构

### MonthView

* 28px 大字月份（`五月 2026`）

* 6×7 网格，1px `#E5E7EB` 分隔

* 非当月日期 `#C7CAD1`；当天数字 `#3370FF` 加粗

* 单元格事件标签最多 3 条，溢出显示 `+N 更多`；跨天事件横向拉通浅底色带

* 单行样式：3px 彩条 + `9 AM 标题…`，可省略号

* 点击单元格空白 → `setViewMode("day")` + `setFocusDate(date)`

* 点击事件标签 → 弹 `EventPopover`

### EventPopover

* 白底 + `#E5E7EB` + 12 圆角 + **无阴影**

* 宽 320px

* 位置策略：

  * 优先跟随点击位置 `right`/`top` 浮出

  * 与底部输入框（固定在底部 `bottom-3`）和 Dev 浮层（右下 `bottom-28 right-8 w-64`）做避让：当默认位置与上述浮层发生矩形相交时，自动 fallback 到居中 Modal

* 结构：

  1. 日期（12 次要色）
  2. 时间（22 加粗）
  3. 标题（18 加粗）
  4. 参与人头像（堆叠）
  5. 地点/线上会议图标文字行
  6. 描述正文
  7. 若 `agentActions` 存在：双按钮区，主按钮黑底白字、次按钮白底边框

* 右上角：✏️ / 🗑️ / × 图标按钮，hover `#F5F6F8`

* 删除二次确认：在 Popover 内弹浅层确认条，确认按钮 `#E5484D`

* 悬停不出浮层；仅点击事件块才出

### EventFormDialog

* 居中 Modal，遮罩 `bg-black/30`

* 表单字段：`主题*`、`内容`、`全天`、`开始*`、`结束*`、`参与人（逗号输入）`、`分类色（6 选 1 色块）`、`地点`

* 底部：左「取消」次按钮，右「保存」主按钮

* 校验：必填校验 + 结束时间 > 开始时间 + 全天模式下隐藏时分

* 成功后：`addEvent / updateEvent` 写 store → 关闭 Modal → 若处于周/日视图且事件落在当前视图范围，自动滚动到该事件

### 交互

* 空白处单击（周/日视图）：创建 30 分钟草稿 → 直接打开 `EventFormDialog`（预填时间）

* 空白处按下拖拽（周/日视图）：使用原生 pointerdown/move/up（不引入 @dnd-kit）；松开后打开 `EventFormDialog`（预填时间区间）

* 事件块点击：`EventPopover`

* 事件块悬停：背景加深 4%（通过叠加 `bg-black/[0.04]`）或边框加深，不出浮层

* 删除：Popover 内 🗑️ → 二次确认 → `deleteEvent`

## 视觉规范执行要点

* 所有容器禁止 `shadow`；`EventPopover`、`EventFormDialog` 一律 `border + rounded-xl + 无阴影`

* 事件色板在 `colorTokens.ts` 中以对象字面量维护：

```ts
export const EVENT_COLORS = {
  blue:   { bg: "#EAF1FF", fg: "#1E4FCC" },
  green:  { bg: "#E6F4EA", fg: "#1F7A3A" },
  purple: { bg: "#EFEAFE", fg: "#5B3DBE" },
  pink:   { bg: "#FCE9EE", fg: "#B0274A" },
  orange: { bg: "#FFF1E0", fg: "#A8590A" },
  cyan:   { bg: "#E0F4F4", fg: "#1B6F73" },
} as const;
```

* 网格线使用内联 `style={{ borderTop: "1px solid #E5E7EB" }}` 或 tailwind `border-t border-[#E5E7EB]`

* 半小时虚线：`border-t border-dashed border-[#EFF1F4]`

* 高亮时段：背景 `#FBF4D8`，z 层在网格上方、事件块下方

## 时间工具（timeGrid.ts）

* `minutesSinceDayStart(date: Date): number`

* `minutesToPx(minutes: number, hourHeight = 48): number`

* `pxToMinutes(px: number, hourHeight = 48): number`（含吸附 15min）

* `getWeekRange(anchor: Date): [start: Date, end: Date]`（以周日为起点）

* `eachDayOfWeek(anchor: Date): Date[]`

* `eachDayOfMonthGrid(anchor: Date): Date[]`（返回 42 天数组，含前月尾和下月头）

* `isSameYmd(a: Date, b: Date): boolean`

* `formatWeekTitle(start: Date, end: Date): string`

* `formatDayTitle(d: Date): string`

* `formatMonthTitle(d: Date): string`

## 与宿主浮层的避让

* 中间主内容区底部预留 `pb-24`

* `EventPopover` 初始化时通过 `getBoundingClientRect` 计算：

  * 若默认位置与 `BottomComposer`（固定 `bottom-3 left-[276px] right-8`）所占矩形相交

  * 或与 `DevPanel`（固定 `bottom-28 right-8 w-64 h-[160px]`）相交

  * 则切换到居中 Modal 呈现

* 不修改 BottomComposer 与 DevPanel

## 假设与决策

1. **不引入新依赖**：dayjs / @dnd-kit / timezone 仅为 PRD 建议；在本次原型里用原生 API + pointer events 等价实现，避免 package 变更
2. **默认呈现 v2**：PRD 第九条"验收标准"明确要求三视图闭环，因此 `/schedule` 默认渲染完整形态；v1 空态保留为可切换组件，便于回退
3. **tailwind token 不动全局**：继续延续当前项目风格（组件内写十六进制色值）
4. **focusDate 默认值**：首次进入取 `useVirtualClock().currentTime` 的日期，保持与宿主 Dev 浮层虚拟时间一致
5. **头像**：Header 右区头像使用静态 `JJ` 显示，不与 UserMenu 联动
6. **键盘交互**：仅在日程页根容器接收键盘事件，避免干扰全局输入框
7. **拖拽精度**：15 分钟吸附；跨多小时允许，但同列创建时结束时间不得早于开始时间
8. **localStorage key**：`kiki.schedule.events`，值为 `AgentEvent[]` JSON

## 实现步骤（Todo 拆解）

1. 建立类型、示例数据、store（含 localStorage 持久化）
2. 时间工具 + 色板常量
3. `ScheduleHeader`（含视图切换、今天、前后、新建按钮）
4. 周视图（含全天条、半小时虚线、当前时间线、事件块、重叠布局）
5. 日视图（含红色胶囊时间、米黄高亮时段）
6. 月视图（含跨天色带、+N 更多、当月/非当月色）
7. `EventPopover`（含删除二次确认、浮层避让）
8. `EventFormDialog`（创建/编辑表单）
9. 创建交互：空白单击 + 拖拽
10. 入口页接线：`app/schedule/page.tsx` 渲染 `SchedulePage`
11. 手工验证 + `pnpm lint` / `pnpm build`

## 验证步骤

1. `pnpm lint` 必须通过
2. `pnpm build` 必须通过
3. 手工核对 PRD 第九节十项验收：

   1. 子页挂载：左栏/底部全局输入框不被覆盖或重绘
   2. 背景、卡片、圆角与宿主一致
   3. 三视图切换保持 `focusDate`；`今天` 立即回今天并滚到当前时间线
   5. 日视图：红徽标日期、红色胶囊时间、米黄高亮时段可见
   6. 月视图：大字月份、6×7 网格、跨天色带、+N 更多
   7. 周视图：GMT+8、列头、全天折叠、半小时虚线、红色当前时间线
   8. 悬停不弹浮层；点击弹 EventPopover；无阴影；底部双按钮
   9. Popover 与底部输入框、Dev 浮层不相互遮挡
   10. 创建/查看/修改/删除闭环；刷新不丢数据；1280×800 无横向滚动条

## 不在本次范围

* 接入真实后端（`/api/events` 仅预留，不实现）

* 移动端适配（桌面优先，最小 1280）

* 拖拽改期/改时长（仅支持创建时拖拽；事件块本身不做移动/缩放）

* 多时区切换（固定 GMT+8）

* 权限、参与人选择器（使用逗号分隔文本输入即可）


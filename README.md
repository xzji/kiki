# KiKi Agent Prototype

目标驱动型自主 Agent 的高保真前端原型。当前版本为纯前端实现，包含：

- 左侧导航、收件箱首页、目标详情页、任务三视图
- 6 类执行内容区：`flashcard`、`listening_qa`、`reading_digest`、`confirm_action`、`draft_review`、`freeform_chat`
- `Zustand` store + mock API 包装
- 虚拟时钟、前端触发引擎与右下角 `Dev` 演示浮层

## 启动方式

```bash
pnpm install
pnpm dev
```

默认访问：[http://localhost:3000](http://localhost:3000)

## 主要路由

- `/`：收件箱首页
- `/goals/[goalId]`：目标详情页
- `/goals/[goalId]/tasks/[taskId]`：任务页，支持 `?view=list|detail|exec`
- `/goals/new?title=准备产品经理面试`：新建目标拆解页
- `/schedule`：日程页占位
- `/history`：历史归档页

## Dev 浮层演示

右下角提供演示浮层，可快速验证“定时触发 -> 生成实例 -> 收件箱出现新卡片”的闭环：

- `快进 1 小时`：将虚拟时间向后推进 1 小时
- `跳到明早 11:00`：直接命中常见每日触发任务

推荐演示步骤：

1. 打开首页 `/`
2. 点击右下角 `跳到明早 11:00`
3. 观察收件箱顶部新增卡片，左侧对应目标红点增加
4. 点击卡片进入任务页，再进入执行壳完成一次闭环

## 代码结构

```text
src/
├─ app/
├─ components/
├─ hooks/
├─ lib/api/
├─ mocks/
├─ stores/
└─ types/
```

## 校验命令

```bash
pnpm lint
pnpm build
```

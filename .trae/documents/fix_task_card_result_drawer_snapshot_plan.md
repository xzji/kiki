# 修复任务卡片点击不弹右侧边栏计划

## Summary

当前“小应用卡片不能点击”的直接现象是：点击任务卡片后没有弹出右侧结果边栏。

复查代码后判断，卡片点击事件本身不是主要问题。更可能的根因是：

```txt
TaskMessageCard 点击
  -> ConversationMessageItem 调用 onOpenResult(message)
  -> ConversationView.setResultMessage(message)
  -> ConversationView 重新计算 resultInfo
  -> resultInfo 只从 goalStore 查找 goal/task/instance
  -> 如果 goalStore 与 conversation message 不同步，resultInfo = null
  -> TaskResultDrawer open={Boolean(resultInfo)} 为 false
  -> 右侧边栏不打开
```

之前已经为消息卡片展示修过一次 `taskSnapshot` 兜底：

```txt
ConversationMessageItem
  message.taskSnapshot -> 可以渲染 TaskMessageCard
```

但 `ConversationView` 中右侧结果边栏仍没有使用 `message.taskSnapshot` 兜底，所以会出现：

* 卡片能显示。

* 点击也触发了 `setResultMessage`。

* 但边栏需要的 `resultInfo` 解不出来。

* 视觉上表现为“点击没反应”。

## Current State Analysis

### 1. 卡片点击入口已存在

文件：`src/components/conversation/TaskMessageCard.tsx`

当前卡片已经绑定：

```tsx
onClick={onOpen}
```

并且支持：

```tsx
role="button"
tabIndex={0}
Enter / Space
```

所以卡片本身已经是可点击区域。

### 2. 消息卡片渲染已有 snapshot 兜底

文件：`src/components/conversation/ConversationMessageItem.tsx`

当前 `taskInfo` 解析逻辑已经支持：

```ts
message.taskSnapshot
```

也就是说，即使 `goalStore` 中找不到当前 instance，消息流仍可以显示卡片。

### 3. 结果边栏解析没有 snapshot 兜底

文件：`src/components/conversation/ConversationView.tsx`

当前 `resultInfo` 逻辑是：

```ts
const goal = goals.find((item) => item.id === resultMessage.taskRef.goalId);
if (!goal) return null;

const task = goal.subGoals
  .flatMap((subGoal) => subGoal.tasks)
  .find((item) => item.id === resultMessage.taskRef.taskId) ?? null;
if (!task) return null;

const instance = task.instances.find((item) => item.id === resultMessage.taskRef.instanceId) ?? null;
if (!instance) return null;
```

问题：

* 只要 `goalStore` 的实例列表没有新 demo instance，`resultInfo` 就会是 `null`。

* `TaskResultDrawer` 的 `open` 取决于 `Boolean(resultInfo)`。

* 所以 `setResultMessage(message)` 已经执行也不会打开边栏。

### 4. 为什么小应用卡片更容易暴露这个问题

小应用 demo 是后来新增的 mock instance。

如果用户浏览器中已经持久化了旧版本 `conversationStore` 或 `goalStore`，可能出现：

* `conversationStore` 里有 task card message。

* message 里有 `taskSnapshot`，所以卡片能显示。

* `goalStore` 没有对应 instance，或者还停留在旧数据。

* 点击后 `ConversationView.resultInfo` 查不到 instance。

这与之前“没有卡片”的问题属于同一类：会话消息与目标 store 的状态不同步。

## Proposed Changes

### 1. 抽出共享的 task card 解析 helper

修改文件：

* `src/components/conversation/ConversationView.tsx`

新增本地 helper，或在当前组件内实现统一解析函数：

```ts
function resolveTaskCardInfo(
  message: ConversationMessage | null,
  goals: Goal[],
) {
  if (!message || message.kind !== "task_card") return null;

  const goal = goals.find((item) => item.id === message.taskRef.goalId) ?? null;
  const subGoal = goal?.subGoals.find((item) => item.id === message.taskRef.subGoalId) ?? null;
  const task = subGoal?.tasks.find((item) => item.id === message.taskRef.taskId) ?? message.taskSnapshot?.task ?? null;
  const instance = task?.instances.find((item) => item.id === message.taskRef.instanceId) ?? message.taskSnapshot?.instance ?? null;

  if (!task || !instance) return null;
  return { goal, subGoal, task, instance, message };
}
```

实现要求：

* 优先使用 `goalStore` 的实时 task/instance。

* 找不到时回退到 `message.taskSnapshot.task` 和 `message.taskSnapshot.instance`。

* `goal` 允许为 `null`，但 `TaskResultDrawer` 当前需要 `goal`，所以需要配套调整。

### 2. 调整 `TaskResultDrawer` 允许 snapshot-only 渲染

修改文件：

* `src/components/task/TaskResultDrawer.tsx`

当前 `TaskResultDrawer` 参数允许：

```tsx
goal={resultInfo?.goal ?? null}
task={resultInfo?.task ?? null}
instance={resultInfo?.instance ?? null}
```

需要确认内部是否在 `goal === null` 时仍能展示结果。

建议规则：

* `open` 只依赖 `task` 和 `instance`，不强依赖 `goal`。

* 如果 `goal` 为空，隐藏或降级面包屑中的目标信息。

* 主体 `TaskResult` 渲染应继续展示，因为小应用 artifact 和 task result 都在 `instance.result.taskResult` 上。

如果 `TaskResultDrawer` 已经支持 `goal=null`，只需改 `ConversationView`：

```tsx
open={Boolean(resultInfo?.task && resultInfo?.instance)}
```

### 3. 让任务信息抽屉也使用同样兜底

修改文件：

* `src/components/conversation/ConversationView.tsx`

当前 `taskInfo` 同样只从 `goalStore` 查找：

```ts
if (!goal) return null;
if (!task) return null;
```

建议同步改成使用同一个 helper，避免“更多 -> 查看任务信息”也受 store 不同步影响。

### 4. 保留 `ConversationMessageItem` 的 snapshot 兜底

文件：

* `src/components/conversation/ConversationMessageItem.tsx`

不需要移除现有逻辑。

但为了避免两处解析逻辑继续分叉，后续可以考虑把 helper 抽到：

```txt
src/lib/conversation/resolveTaskCardInfo.ts
```

第一版可以先在 `ConversationView.tsx` 内部实现，改动更小。

### 5. 可选调试日志

如果修复后仍复现，可以临时加开发环境日志：

```ts
if (process.env.NODE_ENV === "development" && resultMessage && !resultInfo) {
  console.warn("[ConversationView] resultMessage cannot resolve resultInfo", resultMessage);
}
```

但第一版建议不加常驻日志，避免控制台噪音。

## Assumptions & Decisions

* 点击卡片不弹边栏的主因不是 DOM 点击事件，而是 `resultInfo` 解析失败。

* `message.taskSnapshot` 已经是项目中接受的兜底机制，应继续沿用。

* 右侧结果边栏应能展示 snapshot 中的 task/instance，即使当前 `goalStore` 尚未同步。

* 不重置用户 localStorage，不强迫用户刷新 mock baseline；用代码兼容状态不同步。

* 小应用 iframe 本身不参与本问题；问题发生在打开右侧边栏之前。

## Verification Steps

### 1. 静态检查

运行：

```bash
pnpm tsc --noEmit
```

并检查：

* `src/components/conversation/ConversationView.tsx`

* `src/components/task/TaskResultDrawer.tsx`

diagnostics 为空。

### 2. 页面验证

访问：

```txt
http://localhost:3001/conversations/conv-goal-toefl
```

操作：

* 点击 `Surface Demo · 小应用` 卡片任意空白区域。

* 右侧结果边栏应打开。

* 边栏内应展示 `可执行小应用` 区域。

### 3. 回归验证

继续点击：

* 普通 blocks 卡片。

* 文件 only 卡片。

* 混合区域卡片。

* 等待用户卡片。

预期：

* 结果边栏都能正常打开。

* 等待用户面板内部按钮不会因为冒泡导致误打开。

### 4. URL query 验证

如果使用：

```txt
/conversations/conv-goal-toefl?resultMessageId=msg-inst-surface-demo-webapp
```

也应能打开右侧结果边栏。

这可以验证 `resultMessageIdFromQuery -> setResultMessage -> resultInfo` 路径同样支持 snapshot。

## Implementation Order

1. 修改 `ConversationView.tsx`，新增统一 task card 解析 helper。
2. 用 helper 替换 `taskInfo` 和 `resultInfo` 的解析逻辑。
3. 如有必要，微调 `TaskResultDrawer.tsx`，确保 `goal=null` 时仍可展示结果内容。
4. 运行 `pnpm tsc --noEmit`。
5. 访问会话页手动点击小应用卡片验证右侧边栏。


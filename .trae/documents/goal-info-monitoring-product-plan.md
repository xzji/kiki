# 目标详情页新增「信息监控」产品方案

## Summary

目标是在每个已生成规划的 `Goal` 下，新增一层独立于任务执行的「信息监控」能力，让 KiKi 不只是按既定任务推进，还能围绕目标主动观察外部信息变化，判断这些变化是否重要，并进一步决定：

1. 只做静默记录
2. 推送摘要给用户
3. 生成新的待处理事项
4. 自动触发下一步任务或建议用户确认动作

推荐按 **V1 可落地版** 实现，优先复用现有 `/goal` 编排、`goalStore`、`GoalSchedulerRuntime`、`inbox`、对话消息和任务自动执行链路，先形成「配置监控 -> 定时检查 -> 判断变化 -> 触发动作 -> 回流给用户」的闭环。

V1 明确边界：

- 监控在用户打开 Web 应用且本地 Claude 运行环境在线时生效
- 数据仍存于前端 `zustand persist / localStorage`
- 不做服务端常驻 worker，不保证浏览器关闭后继续监控
- 先支持高价值、低依赖的信息源类型，避免一开始接入过多外部搜索依赖

## Current State Analysis

### 1. 目标详情页当前只有规划视图，没有「目标级监控」层

- `src/app/goals/[goalId]/page.tsx`
  - 当前只从 `goalStore` 读取 `goal`，直接渲染 `GoalPlanContent`
- `src/components/goal/GoalPlanContent.tsx`
  - 已有目标概览、工作流状态、子目标列表、任务入口
  - 这是新增「信息监控」模块最合适的承载页

### 2. 当前已经存在可复用的调度和触发雏形

- `src/components/providers/GoalSchedulerRuntime.tsx`
  - 已有基于 `setInterval` 的调度循环
  - 已有「找到到期任务 -> 生成实例 -> 加入 inbox -> 推送会话消息 -> 调用任务执行 API」的完整链路
- `src/hooks/useTriggerEngine.ts`
  - 已有简单的触发引擎概念
  - 虽然更偏 demo，但说明仓库已经接受「规则驱动触发」这种模型
- `src/lib/goalSystemConfig.ts`
  - 已有 scheduler 周期、并发数、心跳超时等配置
  - 可以继续扩展监控相关配置

### 3. 当前数据模型支持任务监控态，但不支持“目标级信息监控配置”

- `src/types/kiki.ts`
  - `Goal` 仅有 `workflow / subGoals / summary` 等字段
  - `Task` 虽然已有 `taskType: "monitoring"` 和 `executionMode: "monitoring"`，但它们仍然是“任务层”抽象
  - 缺少：
    - 监控源定义
    - 监控快照
    - 变化事件
    - 动作规则
    - 监控历史
- `src/stores/goalStore.ts`
  - 目前没有针对监控源和监控事件的增删改查

### 4. 当前系统已经有“通知回流”基础设施

- `inboxStore` 可承载提醒和待确认事项
- `conversationStore` 可承载 KiKi 主动推送消息
- 现有任务执行链路已经能把自动触发的工作转成可查看、可追踪的实例

### 5. 当前最大的产品/架构限制

- 监控调度目前跑在前端运行时，而不是后端持久任务系统
- 这意味着 V1 的“主动性”成立前提是：
  - 用户曾打开应用
  - 页面未彻底关闭
  - 本地 Claude 运行环境在线

因此本方案建议：

- **V1 做应用内主动监控**
- **V2 再演进成服务端持久监控**

## Assumptions & Decisions

### 产品定位

- 「信息监控」是目标级能力，不直接替代任务
- 它负责帮助 KiKi 发现新信息、判断是否重要、把变化转成下一步行动
- 它应与现有 `Task` 协同，而不是把所有监控都塞成普通任务

### V1 范围决策

- 放在目标详情页中，以一个独立模块呈现
- 仅对“已有目标规划”的目标开放配置
- 支持多监控源，但先限制为 3 类高价值来源：
  - `webpage`：用户指定 URL 页面
  - `rss`：RSS/Atom 类订阅源
  - `agent_brief`：用户给出主题，由 Claude 周期性搜集和总结
- 不在 V1 直接支持复杂登录态网站、社媒、需要官方 API Key 的源

### 动作策略决策

采用三级动作策略，避免一上来过度自动化：

1. `record_only`
   - 记录变化，不打扰用户
2. `notify`
   - 发送 inbox / 会话摘要，提醒用户关注
3. `propose_or_trigger`
   - 生成建议动作；高置信更新可自动创建后续任务或自动触发已有任务

其中自动动作仍应受两个闸门限制：

- 来源置信度足够高
- 规则允许自动执行；否则进入待确认

### 调度策略决策

- 继续复用 `GoalSchedulerRuntime` 的主循环，不新建独立前端 runtime
- 主循环周期继续受 `schedulerCycleIntervalMs` 控制
- 每个监控源自己维护 `nextCheckAt`
- scheduler 每轮只挑选到期的监控源，并遵守并发上限

### 判定策略决策

变化不是“有文本差异就算更新”，而是分成两层：

1. **源变化**
   - 原始页面/RSS/Agent 搜集结果发生变化
2. **目标相关变化**
   - 变化是否与当前目标有意义地相关

只有同时满足“有变化 + 与目标相关 + 超过阈值”，才触发下一步动作。

## Proposed Changes

### 一、产品流程设计

#### Flow A：监控方案初始化

触发时机：

- 目标规划生成后，用户进入目标详情页
- `GoalPlanContent` 中新增「信息监控」模块

流程：

1. KiKi 根据 `goal.title`、`goal.summary`、`workflow.collectedInfo`、子目标与任务内容，生成一份监控草案
2. 草案包含：
   - 推荐监控主题
   - 推荐信息源
   - 每类源的检查频率
   - 变化判定标准
   - 默认动作等级
3. 用户可：
   - 一键启用推荐方案
   - 删除/新增监控源
   - 修改频率和动作策略
   - 暂停某个源或整个目标监控

推荐产品表现：

- 默认展示一个「AI 推荐监控方案」卡片
- 用户确认后进入“已启用监控”状态

#### Flow B：定时收集信息源

触发时机：

- `GoalSchedulerRuntime` 每轮扫描所有开启监控的目标

流程：

1. 找出 `goal.monitoring.enabled === true` 的目标
2. 对每个目标找到 `nextCheckAt <= now` 的源
3. 对到期源逐个执行采集
4. 写入本次采集结果：
   - `checkedAt`
   - `status`
   - `rawSummary`
   - `normalizedSnapshot`
   - `fingerprint`
   - `nextCheckAt`

V1 建议的默认频率：

- `webpage`
  - 默认 `360` 分钟
- `rss`
  - 默认 `180` 分钟
- `agent_brief`
  - 默认 `720` 分钟

如果目标被用户标记为“高时效”，则可将高优先级源降到：

- 最快 `60` 分钟一次

#### Flow C：变化检测与重要性判断

每次采集完成后分三步判断：

1. **去重**
   - 比较本次 `fingerprint` 与上次快照
   - 完全一致则视为无更新
2. **语义判断**
   - 对有变化的数据生成结构化判断：
     - 更新摘要
     - 与目标的关联点
     - 新信息影响的子目标/任务
     - 推荐动作
     - 置信度
3. **重要性分级**
   - `none`
   - `weak`
   - `meaningful`
   - `critical`

建议判定维度：

- 是否影响目标成败
- 是否影响时机/截止时间
- 是否影响价格/名额/政策/优先级
- 是否能直接触发已有任务
- 是否仅为重复噪音

#### Flow D：动作执行

当分级完成后，进入动作引擎：

1. `none`
   - 只更新时间戳，不通知
2. `weak`
   - 记录到监控历史，可在详情页查看
3. `meaningful`
   - 生成摘要并推送到：
     - 目标详情页监控动态
     - inbox
     - 会话消息
4. `critical`
   - 若命中规则，执行以下之一：
     - 自动创建一个 follow-up task
     - 自动触发已有 monitoring task
     - 生成待确认事项，由用户决定是否执行

推荐动作映射：

- 资讯型变化：`notify`
- 明确可行动变化：`propose_or_trigger`
- 高风险变化：优先 `need_confirm`

#### Flow E：用户反馈与策略修正

用户可以对每条监控结果做反馈：

- 有用
- 太吵了
- 不相关
- 下次遇到类似情况直接执行 / 先提醒我

V1 不做复杂学习模型，但应记录这些反馈，用于：

- 调整该目标下监控源的权重
- 抬高或降低通知阈值
- 决定是否静默相似更新

### 二、模块拆分设计

#### 模块 1：目标级监控配置模块

承载位置：

- `src/components/goal/GoalPlanContent.tsx`
- 新增 `src/components/goal/GoalMonitoringPanel.tsx`

职责：

- 展示目标监控总开关
- 展示 AI 推荐监控方案
- 展示监控源列表、状态、频率、上次检查时间、下次检查时间
- 提供“新增信息源”“暂停监控”“重新检查”入口

推荐子模块：

- `GoalMonitoringPanel.tsx`
- `GoalMonitoringSetupCard.tsx`
- `GoalMonitoringSourceList.tsx`
- `GoalMonitoringSourceDrawer.tsx`
- `GoalMonitoringEventFeed.tsx`

#### 模块 2：监控方案生成模块

新增接口：

- `src/app/api/goals/monitor/plan/route.ts`
- `src/lib/server/goalMonitoringPlan.ts`

职责：

- 根据目标规划自动推荐：
  - 监控主题
  - 监控源
  - 频率
  - 重要性规则
  - 默认动作策略

输入：

- `goal.title`
- `goal.summary`
- `goal.workflow.collectedInfo`
- 子目标和任务

输出：

- 结构化监控蓝图 `GoalMonitoringDraft`

#### 模块 3：信息源适配与采集模块

新增文件建议：

- `src/lib/server/goalMonitoringCollector.ts`
- `src/lib/server/goalMonitoringSourceAdapters.ts`

职责：

- 根据 source type 执行采集
- 统一返回标准化结果

V1 三类 source adapter：

1. `webpage`
   - 直接抓取 HTML 后提取正文摘要
2. `rss`
   - 解析 feed 条目，抽取最新 N 条
3. `agent_brief`
   - 调用 Claude CLI，围绕给定主题做一次“最新动态巡检”

标准输出建议：

- `sourceId`
- `checkedAt`
- `status`
- `rawPayload`
- `normalizedText`
- `normalizedFacts`
- `fingerprint`

#### 模块 4：变化检测与语义判定模块

新增文件建议：

- `src/lib/server/goalMonitoringJudge.ts`
- `src/lib/server/goalMonitoringPrompt.ts`

职责：

- 对比新旧快照
- 判断是否为有效变化
- 输出变化等级和推荐动作

核心输出结构建议：

- `hasUpdate`
- `changeType`
- `importance`
- `relevanceScore`
- `confidenceScore`
- `summary`
- `reason`
- `suggestedActions`
- `relatedSubGoalIds`
- `relatedTaskIds`

判断逻辑建议：

1. 先规则去重
2. 再 LLM 语义判断
3. 最后动作规则映射

#### 模块 5：动作引擎模块

可扩展现有：

- `src/components/providers/GoalSchedulerRuntime.tsx`
- `src/stores/goalStore.ts`
- `src/stores/inboxStore.ts`
- `src/stores/conversationStore.ts`

新增文件建议：

- `src/lib/goalMonitoringActionEngine.ts`

职责：

- 根据变化分级决定：
  - 静默记录
  - 发 inbox
  - 发会话消息
  - 生成 follow-up task
  - 自动触发已有任务

推荐动作模板：

- `record_only`
- `push_digest`
- `create_followup_task`
- `trigger_existing_task`
- `request_user_confirmation`

#### 模块 6：监控历史与结果可视化模块

承载位置：

- `GoalMonitoringEventFeed.tsx`

职责：

- 按时间展示每次监控事件
- 标明来源、变化等级、是否已处理
- 支持筛选：
  - 全部
  - 仅重要
  - 已触发动作
  - 仅未读

### 三、数据结构设计

需要在 `src/types/kiki.ts` 扩展以下结构。

#### Goal 上新增

- `monitoring?: GoalMonitoringState`

#### GoalMonitoringState 建议字段

- `enabled: boolean`
- `status: "idle" | "active" | "paused" | "error"`
- `goalPrompt?: string`
- `highPriorityMode?: boolean`
- `sources: GoalMonitoringSource[]`
- `events: GoalMonitoringEvent[]`
- `lastCheckedAt?: string`
- `nextCheckAt?: string`
- `lastSignificantEventAt?: string`

#### GoalMonitoringSource 建议字段

- `id`
- `title`
- `type: "webpage" | "rss" | "agent_brief"`
- `config`
- `checkIntervalMinutes`
- `enabled`
- `lastCheckedAt?`
- `nextCheckAt?`
- `lastSnapshot?`
- `lastError?`
- `defaultAction`
- `requiresConfirmation`

#### GoalMonitoringSnapshot 建议字段

- `checkedAt`
- `fingerprint`
- `summary`
- `facts`
- `rawRef`

#### GoalMonitoringEvent 建议字段

- `id`
- `sourceId`
- `createdAt`
- `importance`
- `summary`
- `reason`
- `hasUpdate`
- `action`
- `status: "new" | "notified" | "triggered" | "dismissed"`
- `relatedTaskIds`
- `payload`

### 四、页面交互设计

#### 目标详情页新增信息监控区块

插入位置建议：

- `GoalPlanContent.tsx` 中目标概览卡片下方、子目标列表上方

区块结构建议：

1. 顶部摘要卡
   - 监控状态
   - 已启用源数量
   - 上次检查时间
   - 今日发现更新数
   - 手动立即检查按钮
2. AI 推荐卡
   - 首次进入时展示
   - 支持“一键启用”
3. 信息源列表
   - 每个源一行卡片
   - 可查看频率、动作策略、最近状态
4. 监控动态流
   - 展示最新变化和触发动作

#### 关键交互

- 总开关：启用 / 暂停整个目标监控
- 单源开关：暂停某个噪音源
- 手动检查：立刻对某个源或整个目标执行一次采集
- 一键转任务：把一条关键变化直接转成任务
- 降噪反馈：标记“不重要”

### 五、调度与执行逻辑

#### 调度入口

扩展 `src/components/providers/GoalSchedulerRuntime.tsx`

当前已有：

- 任务调度循环

新增：

- 监控源调度循环，建议和任务调度复用同一主循环

每轮执行顺序建议：

1. 处理已有任务 watchdog
2. 推进已有任务自动执行
3. 检查信息监控源是否到期
4. 对到期源执行采集和判断
5. 将结果写回 `goalStore`
6. 必要时创建 inbox / conversation / follow-up task

#### 并发策略

建议与 `maxConcurrentTasks` 分开，不要直接共用一个槽位。

在 `src/lib/goalSystemConfig.ts` 新增：

- `maxConcurrentMonitorChecks`
- `defaultMonitorIntervalMinutes`
- `monitorBackoffMinutes`
- `monitorEventRetentionDays`

默认值建议：

- `maxConcurrentMonitorChecks = 2`
- `defaultMonitorIntervalMinutes = 360`
- `monitorBackoffMinutes = 30`
- `monitorEventRetentionDays = 14`

#### 失败与退避

采集失败时：

- 不立即报错打断整个目标
- 记录 `source.lastError`
- 将 `nextCheckAt` 延后 `monitorBackoffMinutes`
- 连续失败超过阈值后在 UI 中标红，并给用户一个修复入口

### 六、动作触发设计

#### 触发 follow-up task 的规则

当事件满足以下条件时，可自动生成任务：

- `importance === "critical"`
- 有明确行动建议
- 能映射到某个子目标
- 用户没有关闭自动创建

新增任务建议类型：

- `taskType = "one_shot"`
- `executionMode = "event_triggered"`
- `executionKind = "generic_result"` 或 `confirm_action`

任务标题示例：

- `监控触发：XX 信息已更新，请确认是否执行`
- `监控触发：根据最新变化补充候选方案`

#### 自动触发已有任务的规则

适合以下场景：

- 目标本身已有 monitoring task
- 监控事件与某个已有 task 显式绑定

例如：

- 发现新政策发布 -> 触发“整理政策摘要”任务
- 发现价格变化 -> 触发“更新购车对比表”任务

### 七、接口与文件落点

#### 需要修改的现有文件

- `src/types/kiki.ts`
  - 新增监控相关类型
- `src/stores/goalStore.ts`
  - 增加监控配置、事件、快照的 state 和 action
- `src/components/goal/GoalPlanContent.tsx`
  - 增加「信息监控」区块入口
- `src/components/providers/GoalSchedulerRuntime.tsx`
  - 扩展监控调度循环
- `src/lib/goalSystemConfig.ts`
  - 增加监控配置项
- `src/lib/api/goals.ts`
  - 新增 monitor 相关 API 调用方法

#### 建议新增的 UI 文件

- `src/components/goal/GoalMonitoringPanel.tsx`
- `src/components/goal/GoalMonitoringSetupCard.tsx`
- `src/components/goal/GoalMonitoringSourceList.tsx`
- `src/components/goal/GoalMonitoringSourceDrawer.tsx`
- `src/components/goal/GoalMonitoringEventFeed.tsx`

#### 建议新增的 API 路由

- `src/app/api/goals/monitor/plan/route.ts`
- `src/app/api/goals/monitor/check/route.ts`
- `src/app/api/goals/monitor/run-now/route.ts`

#### 建议新增的服务端实现

- `src/lib/server/goalMonitoringPlan.ts`
- `src/lib/server/goalMonitoringCollector.ts`
- `src/lib/server/goalMonitoringSourceAdapters.ts`
- `src/lib/server/goalMonitoringJudge.ts`
- `src/lib/server/goalMonitoringPrompt.ts`

#### 可选新增的辅助文件

- `src/lib/goalMonitoringActionEngine.ts`

## Recommended V1 Logic Details

### 1. 怎么收集监测的信息源

来源分两种：

1. **AI 推荐**
   - 从目标规划里抽取：
     - 需要持续观察的对象
     - 关键变量
     - 风险点
     - 时间敏感点
2. **用户补充**
   - 用户手动填入：
     - 页面链接
     - RSS
     - 主题描述

推荐的生成逻辑：

- 先根据 `goal.summary + subGoals + tasks + assumptions + risks`
- 生成 3-5 个“值得监控的对象”
- 每个对象再映射成 1-3 个候选源

例子：

- 目标：购买 SUV 汽车
  - 值得监控的对象：
    - 候选车型价格
    - 优惠政策
    - 用户口碑变化
    - 新车型发布
- 目标：托福 110 分
  - 值得监控的对象：
    - 最新练习素材
    - 考试报名节点
    - 高频错题趋势
    - 学习节奏波动

### 2. 多久定时监控一次

不要为所有源设置统一频率，应按源类型和目标时效性决定。

V1 推荐公式：

- 基础频率 = source type 默认值
- 若目标开启高优先模式，频率减半
- 若连续无变化 3 次，可逐步拉长到 1.5 倍
- 若最近出现重要更新，短期内缩短 0.5 倍做二次确认

默认值：

- `rss`：180 分钟
- `webpage`：360 分钟
- `agent_brief`：720 分钟

### 3. 如果有更新，怎么判断和执行下一步动作

建议采用“规则 + LLM”的混合判断。

第一层，规则判定：

- 指纹变化
- 时间窗口去重
- 标题/链接是否重复

第二层，LLM 判定：

- 这条变化是否和目标强相关
- 会影响哪个子目标或任务
- 是否需要立即行动
- 应该提醒、建任务，还是自动推进

第三层，动作映射：

- `weak` -> 仅写入事件流
- `meaningful` -> inbox + 会话提醒
- `critical` + `requiresConfirmation=false` -> 自动建任务或触发任务
- `critical` + `requiresConfirmation=true` -> 生成待确认事项

## Acceptance Criteria

当执行本方案时，V1 应满足以下验收标准：

1. 目标详情页可看到独立的信息监控模块
2. 用户可为目标启用/暂停监控，并能管理多个信息源
3. KiKi 可基于目标规划自动推荐至少一版监控草案
4. scheduler 能按 `nextCheckAt` 扫描并执行到期源
5. 系统能对监控结果做去重和重要性判断
6. 有意义更新会回流到目标详情页动态流
7. 重要更新可推送到 inbox / 会话
8. 关键更新可创建 follow-up task 或进入待确认
9. 错误不会打断整个目标系统，只会影响对应 source
10. 应用刷新后监控配置和历史仍可从本地持久化恢复

## Verification Steps

### 产品验证

1. 创建一个已有规划的目标，进入目标详情页
2. 确认可看到信息监控模块及 AI 推荐配置
3. 启用一个 `webpage` 或 `rss` 监控源
4. 手动执行一次检查，确认产生快照和事件
5. 模拟一次有更新的数据，确认系统能判定为 `meaningful` 或 `critical`
6. 确认关键事件能推送到 inbox / 对话，必要时能生成 follow-up task
7. 暂停单个源和整目标监控，确认 scheduler 不再执行

### 技术验证

1. `goalStore` 的监控配置、事件和快照能正确持久化
2. `GoalSchedulerRuntime` 在不影响现有任务调度的情况下推进监控检查
3. monitor API 在无网络 / 解析失败 / Claude 失败时能返回可恢复错误
4. 相同更新不会重复生成事件或重复触发动作
5. 页面刷新后 UI 状态与 store 状态保持一致

## Out Of Scope For V1

- 浏览器关闭后继续监控
- 服务端常驻任务系统
- 复杂登录态网站抓取
- 接入需要正式商业 API 的搜索/社媒平台
- 基于长期反馈的自动机器学习调参

## Follow-up For V2

若 V1 证明用户有价值，下一阶段再升级为：

1. 服务端持久监控 worker
2. 更丰富的信息源适配器
3. 监控事件和任务的双向联动看板
4. 用户反馈驱动的个性化噪音过滤
5. 多目标之间共享监控主题和信号

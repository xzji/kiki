# P0 下一步执行方案

> 制定时间：2026-05-29
> 输入依据：[project-progress-assessment.md](file:///Users/bytedance/Documents/trae/long_horizon_agent/docs/project-progress-assessment.md) 中的 P0 优先级建议
> 范围：仅展开两条 P0
> - **P0-A**：调度真正下沉到 daemon（即《方案 A：调度下沉与事件流》）
> - **P0-B**：协议层去重 + 服务端事实源
> 已有底稿：[方案A-调度下沉与事件流.md](file:///Users/bytedance/Documents/trae/long_horizon_agent/docs/plans/方案A-调度下沉与事件流.md)（v2）
> 最近更新：2026-05-29（P0 本地收口实现后）

---

## 最新状态（2026-05-29）

| 事项 | 当前状态 | 说明 |
|---|---|---|
| daemon scheduler / notification worker / watchdog | ✅ 主链路已具备 | 浏览器侧 Scheduler 已默认关闭，仍需 12h/24h dogfood 验收 |
| runtime environment 命令式 API | ✅ 已完成 | 新增 service / route / frontend helper，设置页已切流 |
| schedule event 命令式 API | ✅ 已完成 | 新增 service / route / frontend helper，日程页已切流 |
| `/api/runtime/state/sync` 反向写路径 | ✅ 已删除 | `syncRuntimeStateSnapshot` helper 同步删除 |
| server 协议归一 | ✅ 已完成首轮 | `normalizeAwaitingInteraction` / `normalizeResultHeadline` 已接入，`pnpm test:planning` 已覆盖 |
| UI selector 化 | ✅ 已完成首轮 | `awaitingDisplayModel.ts` 不再承担主要语义去重 |
| 多端实时同步 | ⚠️ 未完成 | runtime/schedule 跨 tab 仍需 BroadcastChannel 或专用事件通道 |
| snapshot 乐观锁 | ⚠️ 未完成 | `expectedRevision` 能力存在，但新命令 service 尚未启用 |
| 旧 persist 数据迁移 | ⚠️ 未完成 | 历史缓存数据仍可能绕过 server 归一 |
| LLM Prompt 禁止重复输出 | ⚠️ 未完成 | 当前主要依赖 server 出口兜底 |

---

## 0. 总体节奏

两条 P0 **不是串行**，而是"地基同源、并行推进"：

```
Sprint 1 (本周)        Sprint 2-3 (下两周)        Sprint 4 (第 4 周)
────────────────       ──────────────────         ──────────────
事件流地基             daemon 接管 + 协议去重     默认开关切 daemon
+ 协议字段审计         + 命令式 API + 事实源      + 旧路径下线
                       一并铺事件流通道
```

- P0-A 的"事件日志"是 P0-B 的"服务端事实源"的物理基础；先把表和 append 接口立起来，两条线之后就能并行
- 每个 Sprint 都有可灰度的 feature flag，**不允许 big-bang 切换**

---

## P0-A · 调度真正下沉到 daemon

> 详细技术方案见 [方案A-调度下沉与事件流.md](file:///Users/bytedance/Documents/trae/long_horizon_agent/docs/plans/方案A-调度下沉与事件流.md)
> 本节只列「下一步要做的事 + 验收口径」，避免重复

### A.1 一句话目标

> 关掉浏览器 12 小时回来，目标该跑的跑了、该投递的通知投递了、该超时的暂停了。

### A.2 关键现状（v2 修正后的真相）

| 项 | 实际状态 |
|---|---|
| 浏览器侧调度器 | 现网默认**已关闭** |
| daemon 派发任务 | 已经是事实主调度，但 **缺 watchdog、缺通知投递** |
| 通知投递 / 会话注入 / watchdog | **始终在浏览器跑** ← 真正卡点 |

> **结论**：P0-A 真正要做的不是"重写调度"，而是把 watchdog 和通知投递从浏览器搬到 daemon，并把所有状态变化写到统一事件流。

### A.3 Sprint 拆分与里程碑

| Sprint | 目标 | 工时 | 用户可感知 |
|---|---|---|---|
| **A-S1** 事件流地基 | 建表 + 双写 + 对账 | 4-5 天 | 无（内部） |
| **A-S2** daemon 补齐 watchdog + 通知投递 | 关浏览器也能投递通知 | 5-6 天 | **关浏览器后通知正常** |
| **A-S3** 事件流接管视图 | 命令式 API + 事件回放 | 5 天 | **详情页可回放、刷新不丢状态** |
| **A-S4** 默认开关切 daemon + 旧路径下线 | 全量切换 | 3 天 | 体验显著更稳 |

合计 17-19 个工作日。

### A.4 立即可启动的 4 件事（Sprint A-S1）

| # | 动作 | 产出物 | 负责面 |
|---|---|---|---|
| A-1 | schema migration v7：建 `goal_event_log` 表 | 迁移脚本 + 单测 | 后端 |
| A-2 | 实现 `goalEventLogRepository`：`appendEvent` / `getEvents` / 幂等键去重 | repo + 单测 | 后端 |
| A-3 | 在 `goalTaskRunner.ts`、`goalSchedulerEngine.ts` 关键节点**双写**事件 | diff PR + 双写一致率脚本 | 后端 |
| A-4 | CI 任务：双写对账脚本（≥ 99.9% 才能进 S2） | `scripts/reconcile-goal-event-log.ts` 已有，加入 CI | DevInfra |

### A.5 验收指标

| 指标 | 目标 |
|---|---|
| 关浏览器 12h 后任务完成率 | ≥ 95% |
| 关浏览器 12h 后通知投递率 | ≥ 99% |
| 刷新前后状态一致率 | ≥ 99% |
| 双写一致率 | ≥ 99.9% |
| 命令式 API 幂等率 | 100% |
| 回滚演练通过 | 必过 |

### A.6 风险与回滚

- **daemon 离线** → 健康检测 fallback 到浏览器调度器（保留旧路径，feature flag 兜底）
- **事件爆量** → progress 事件节流（≥5%/≥1s 才记）
- **回滚** → 不停止 append（保留审计），只切读路径回 snapshot

---

## P0-B · 协议层去重 + 服务端事实源

> 这条线是"长尾 UI Bug 根因治理"。`awaitingDisplayModel.ts` 是**显示侧补丁**，根因是协议本身让模型把同一份信息塞进多个字段。

### B.1 一句话目标

> 同一条信息在协议里只有**一个**权威字段；UI 不再做去重判断，看见什么显示什么。

### B.2 当前协议冗余的 4 处典型现场

| 冗余字段对 | 现状 | 影响 |
|---|---|---|
| `notification.snippet` ↔ `interactionRequirement.question` ↔ `fields[].question` | 三处都可能装"同一个问题" | 卡片显示三遍同一句话 |
| `result.summary` ↔ `result.headline` ↔ `notification.snippet` | 摘要与 headline 经常重复 | 卡片头/正文重复 |
| `meta.role` 缺省 vs 显式 `agent_deliverable` | 历史数据多种来源 | 误判为占位 |
| `taskResultViewKind` 旧值（flashcard 等） | 已有 `normalizeTaskResultViewKind` 兜底 | 边界正常但说明协议曾发散 |

### B.3 治理思路（产品视角）

1. **每个语义信息只允许一个出处** —— 砍冗余
2. **不能完全去除的（协议历史包袱），由 server 在边界归一化** —— 守住边界
3. **UI 不做语义判断** —— 显示侧只负责呈现

### B.4 三阶段执行

#### 阶段 B-1：协议字段审计（与 A-S1 并行，约 2-3 天）

- [ ] 全量梳理 `TaskMessageCard / AwaitingUserResumePanel / InboxCard / GenericAgentResultView` 上游所有字段来源
- [ ] 输出 **字段重复矩阵**（Markdown 表）：每条语义信息当前由谁产生、谁存储、谁渲染
- [ ] 标注每条字段的去留决策：保留 / 合并 / 由 server 派生
- [ ] 产出物：`docs/plans/protocol-deduplication-audit.md`

#### 阶段 B-2：协议归一与 server 派生（约 5-6 天）

- [ ] 在 server 边界（API / LLM 解析 / 存储）增加协议归一函数：
  - 已有：`normalizeTaskResultViewKind`
  - 新增：`normalizeAwaitingInteraction`（统一 `notification.snippet` / `question` / `fields[].question` 的来源关系）
  - 新增：`normalizeResultHeadline`（统一 `summary` 与 `headline` 的来源关系）
- [ ] 在 LLM Prompt 协议里**显式禁止重复输出**（参照 `taskDraftSchema.ts` 的 block 协议风格）
- [ ] 把现有 `awaitingDisplayModel.ts` 改为**纯 selector**（不再做语义判断，只挑字段）
- [ ] 在 `run-planning-specs.ts` 增加协议归一回归测试

#### 阶段 B-3：服务端事实源收口（依赖 A-S3 命令式 API，约 4-5 天）

- [ ] 把 `inboxStore` / `scheduleStore` 改为**事件订阅派生**，不再前端写
- [ ] 把 `goalStore` 的写操作收敛为命令式 API（与 A-S3 同步进行）
- [ ] `runtime_state_snapshots` 不再被前端直接写，仅作为事件 reducer 的物化视图

### B.5 立即可启动的 3 件事

| # | 动作 | 产出物 |
|---|---|---|
| B-1 | 启动协议字段审计 | 字段重复矩阵 |
| B-2 | 提出协议归一草案（含 LLM Prompt 调整） | RFC 文档 |
| B-3 | 把 `awaitingDisplayModel.ts` 标记为"过渡层"（注释 + TODO 引用本计划） | 代码注释 |

### B.6 验收指标

| 指标 | 目标 |
|---|---|
| 卡片重复显示 Bug 复发率 | 30 天内 0 例 |
| 协议归一回归测试覆盖 | `pnpm test:planning` 中独立 spec ≥ 5 条 |
| 前端语义判断代码行数 | 比当前下降 ≥ 50% |
| 协议字段重复矩阵中"重复"项 | 阶段 B-2 后归零 |

---

## 联动检查表（两条 P0 之间）

| 触点 | 联动方式 |
|---|---|
| 事件日志 schema | A-S1 建表时预留 `payload_json` 中的归一字段位（与 B-1 字段矩阵协同） |
| 命令式 API（transition / respond） | A-S3 与 B-3 共用同一批 API，避免重复设计 |
| 通知投递 | A-S2 daemon 投递通知时，**直接用归一后的协议**（B-2 产物）写 inbox |
| 回归测试 | A、B 两条线的 spec 都注册到 `run-planning-specs.ts`，CI 同跑 |

---

## 时间表（建议）

| 周 | A 线 | B 线 |
|---|---|---|
| W1 | A-S1 事件流地基 | B-1 协议字段审计 |
| W2 | A-S2 daemon 补齐 watchdog/通知 | B-2 协议归一 + server 派生 |
| W3 | A-S3 事件流接管视图 + 命令式 API | B-3 服务端事实源收口（依赖 A-S3） |
| W4 | A-S4 默认开关切 daemon + 旧路径下线 | B 线收尾、回归测试加固 |

合计 **约 4 周**，每周一次内部 dogfood 验收。

---

## 给老板的一句话

> 接下来 4 周做两件事：把"调度大脑"真正搬进后台进程（关浏览器也跑），把"协议冗余"在服务端归一收口（UI 不再做语义判断）。第一件事让 KiKi 像"常驻 Agent"，第二件事让 UI 长尾 Bug 止血。两件事共用同一套事件流和命令式 API，做完后项目就从"演示原型"过渡到"可信赖的本地 Agent"。

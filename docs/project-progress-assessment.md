# KiKi 项目进展评估（产品视角）

> 评估时间：2026-05-29
> 最近更新：2026-05-31（浏览器 Scheduler 已下线 + 命令式 API + 模型上下文边界 hardening 完成）
> 评估视角：以最初产品立项预期为锚点，对当前实现进行差距盘点
> 文档目的：给非工程角色（产品、决策者）一份可读的现状画像

---

## 一、最初的产品预期

回顾立项时的核心命题：

> 一个围绕"长期目标"的本地 Agent。用户用自然语言提一个目标，KiKi 帮你澄清→拆解→自动调度执行→把进展持续推回收件箱/会话/日程，让人感觉像有一位"会自己干活的助手"。

这意味着初始预期里有 5 条主线：

1. **入口**：对话能自然区分"闲聊"和"做事"（`/goal`）
2. **规划**：能从模糊目标做出一份"产品级可执行计划"
3. **执行**：任务能脱离用户主动操作，自动跑起来
4. **回流**：执行进展能回到收件箱、会话流、日程、任务卡，让用户随时看见
5. **运行时**：不是浏览器小 Demo，而是一个本地常驻的 Agent 系统

---

## 二、做得不错的部分

### ✅ 1. 入口与对话体验（达成度高）
- `/goal` 已经是真正的多轮澄清编排，不是"一发 Prompt 就出结果"
- 普通对话和 `/goal` 同一个输入框、不同工作流，命令做了胶囊化、Backspace 整体删除，符合产品最初想要的"轻入口、重内核"
- 普通对话已经接上 Claude 原生 `--resume` 真实连续会话

### ✅ 2. 规划质量（达成度高）
- `/goal` 已具备"信息收集→子目标拆解→任务生成→Review→规划草案"五步编排
- 解决了大语言模型最大的稳定性瓶颈：从"硬解析 JSON" 重构为 **block 协议（`<task>` + CDATA）+ 系统侧编译器**，把"模型只负责语义草稿、系统负责结构"做成了硬约束
- ID 唯一性、依赖映射、checkpoint v2 这些工程细节都补齐了

### ✅ 3. 任务结果协议收敛（达成度高）
- 砍掉了 `flashcard / listening_qa / draft_review / confirm_action` 等业务化内置视图，统一收敛到 **`generic_result` 通用协议**
- 在 API、LLM、存储三个边界都加了 `normalizeTaskResultViewKind`，避免历史脏数据
- 等待用户补充信息的卡片，从单问单答升级到 **多字段（fields[]）模型**，能一次问"城市+日期+预算"，不再只能回答"都不是"

### ✅ 4. 权限与运行环境（达成度中高）
- 形成了独立的 **Tool Policy / File Policy** 概念：把 22 个 CLI 原子工具聚合成"联网/读写文件/终端/子代理"几个用户友好的能力组
- 解决了"模型自己幻觉出一个授权弹窗"的根因（CLI 没声明 allowedTools）
- 干净环境变量、运行环境切换、健康检查都是真实跑起来的

### ✅ 5. 调试与开发基础设施（达成度高）
- Claude Trace 面板：prompt / thinking / stdout / 解析事件 全链路落盘并能在前端原文查看
- `pnpm test:planning` 把规划/选择/展示模型做成了 CI 级回归测试
- 自检文化已落地（每次改动后做 self-critique）

### ✅ 6. P0 本地收口与云迁移预备（达成度高）
- 浏览器侧 Scheduler / NotificationWorker / Watchdog 已**完全下线**：`GoalSchedulerRuntime` 仅保留 settings hydrate
- daemon scheduler / notification worker / recovery worker 是**唯一**的状态生产者
- runtime environment / schedule event / conversation / goal 全部切到命令式 API：浏览器不再写服务端
- `/api/runtime/state/sync` 路由与 `syncRuntimeStateSnapshot` helper 已删除，浏览器状态彻底定位为 projection-only
- SSE 多路聚合到 `/api/runtime/events/stream`，解决浏览器 HTTP/1.1 连接池耗尽
- 协议归一已下推到 server 出口：`normalizeAwaitingInteraction` / `normalizeResultHeadline` 负责提前消除 question / snippet / field question 的重复
- runtime/schedule 已补齐 `BroadcastChannel` 跨 tab 刷新、`expectedRevision` 乐观锁、projection persist migration
- `scripts/dogfood-daemon.ts` 已提供 12h/24h 离线验收采样脚本
- 模型上下文边界已建立：白名单 Pick 构造 LLM Payload，禁止 Spread 透传内部元数据
- Prompt 脱敏层防止 `quotedMessage` 在 `transport.ts` 二次注入
- Claude session ID 仅采纳 `system.subtype="init"` canonical ID，过滤 hook/error 临时 ID
- LLM Prompt 已增加重复输出禁止规则，并纳入 `pnpm test:planning` 回归
- 本轮修复后 `pnpm tsc --noEmit`、`pnpm test:planning`、`pnpm lint` 均通过

### ✅ 7. 目标级交付物（达成度中）
- 已新增 `goal_deliverables` 物化表、`goalDeliverableService`、目标交付包 API 和交付页
- 交付包已从"任务摘要列表"升级为聚合 `taskResult.blocks`、`result.artifacts`、`payload.artifacts`
- daemon 只在交付包内容变化时写库，避免 revision 无意义增长
- 交付页已支持 heading / paragraph / markdown / list / key-value / table / callout 等通用结果块

### ✅ 8. 产物可交互（达成度中）
- Markdown 表格 → `.xlsx` 自动派生 + 在线编辑器 + 下载导出，已经接近"小应用"的雏形

---

## 三、和最初预期还有差距的部分

### ⚠️ 1. "脱离浏览器自动跑"——主链路完成，仍需长时间样本验证
**最初预期**：关掉浏览器，KiKi 也能在后台推进任务，回来就看到收件箱里堆好结果。

**最新现状**：
- 浏览器侧 Scheduler 已**完全下线**（`GoalSchedulerRuntime` 仅保留 settings hydrate）
- daemon 是 goal / task / runtime / schedule 状态的**唯一写入者**
- 浏览器只通过 SSE 消费事件并更新 UI projection
- 事件日志、命令式 API、runtime snapshot 已形成完整后台执行闭环
- `scripts/dogfood-daemon.ts` 采样脚本已具备，可记录关浏览器 12h/24h 后任务完成率、通知投递率、watchdog 行为
- 仍缺少真实 12h/24h dogfood 数据：脚本已具备，但还没有跑出长期验收样本
- daemon 离线/崩溃后的产品兜底体验还不完整，例如用户如何知道 daemon 掉线、如何恢复

> **PM 视角**：架构层面的"脱离浏览器自动跑"已成立，剩下是真实长时间样本验证 + daemon 健康可视化。

### ⚠️ 2. 状态边界——核心写路径已收口，但多端一致性还没完全产品化
**最初预期**：服务端是事实源，前端只是视图。

**最新现状**：
- conversation / goal / runtime environment / schedule event 全部走命令式 API
- `/api/runtime/state/sync` 反向同步路由已删除，浏览器不再作为权威写入口
- `conversationStore` 已从 `persist` 重构为 read-only projection（SSE + snapshot hydrate）
- `runtimeEnvStore` / `scheduleStore` / `goalStore` 已彻底移除 localStorage 业务数据
- runtime/schedule 已通过 `runtimeStateChannel` (BroadcastChannel) 补齐浏览器多 tab 通知
- 命令 API 已接入 `expectedRevision` / `If-Match`，冲突返回 409 并回灌最新 snapshot
- revision 防旧覆盖：旧 snapshot 不会回滚新命令结果
- 仍未完成云端多设备实时同步：BroadcastChannel 仅覆盖同浏览器多 tab，未来还需要 Tunnel Hub / SSE 下行承接

> **PM 视角**：本机一致性已闭环，剩余是云端多设备同步（与服务端事件序列化协议绑定）。

### ⚠️ 3. 多容器联动——回流通了，但深度不够
**最初预期**：收件箱、会话、目标页、任务页、日程是一个"一体的目标 OS"。

**实际现状**：
- 通了，但更像"同一份数据在五个容器分别渲染"
- 跨容器的语义还薄弱：比如"日程上点一个事件能直接看到对应任务实例"、"收件箱聚合多任务进展"这种联动还偏静态
- 通知 ID 序号化、push-not-replace 这些底层管道刚刚做完，上层还没长出真正"信息流式"的产品形态

### ⚠️ 4. 长程 UI 健壮性——主要根因已治理，仍需观察回归
最近几天处理的几个 Bug 暴露了这一点：
- 任务卡片信息重复（`notification.snippet` / `interactionRequirement.question` / `fields[].question` 三层都装了同一个问题）
- Bash 长路径不换行被截断
- Stop 任务后视图崩溃（数组越界）
- 历史消息被覆盖（同 ID 替换）

最新进展：
- 重复显示问题已经从 UI 补丁层下推到 server 协议归一层处理
- `notification.snippet` 与 `resultSummary.headline` / `interactionRequirement.question` 重叠时会被清空
- `fields[].question` 与主问题重叠时会被清空，由 UI 回退显示 description / label
- 历史消息 push-not-replace 已通过唯一 message id 和 append-only 逻辑修复
- 长命令 / 长路径换行已修复

剩余风险：
- 历史任务运行产物里仍有旧格式内容，重新展示时可能需要 server 归一兜底
- LLM Prompt 已显式禁止重复输出，但仍需要 dogfood 观察模型是否稳定遵守
- 需要至少一段 dogfood 周期观察"重复显示 Bug 复发率"

### ⚠️ 5. 多模态产物落地——只走了第一步
**最初预期**（见 `kiki_multimodal_artifact_landing_plan.md`、`executable-mini-app-surface-plan.md`）：任务能产出可交互的小应用、网页、可执行物料。

**实际现状**：
- Markdown / 表格 / Excel 这一档做完了
- "Artifact Demo"卡片只是在 mock 里展示
- 真正的"任务自动产出一个可运行小应用"还没跑通

### ⚠️ 6. 多 Agent / 长程协同——只有调研
- `multi_agent_orchestration_research_plan.md`、`managed-agents-借鉴评估方案.md` 还停留在评估阶段
- 当前还是单 Agent + 顺序任务，**离"多个子 Agent 并行协作完成一个目标"还有距离**

### ⚠️ 7. 结果质量与"可交付感"
任务跑完出的是一份 Markdown / 表格，**用户视角的"这件事真的被搞定了"还差一口气**：
- 目标级交付包已经有基础模型和页面，但仍偏"聚合展示"，还没有完整验收、返修、确认完成流程
- 缺少质量校验（任务自评 / 用户验收闭环虽然有 `task-acceptance-repair-plan.md`，但还没闭环到产品上）
- 任务完成 ≠ 目标达成，这层语义还没建模

---

## 四、一句话总结

> **KiKi 现在是个"能从模糊目标拆出可执行计划、并把任务跑通、把结果回流到多个产品容器"的可演示 Agent 原型。**
> **本轮 hardening 后，浏览器 Scheduler 已彻底下线，daemon 成为唯一生产者，命令式 API + SSE projection 架构已落地，模型上下文边界已建立；下一步重点是真实长时间 dogfood、daemon 掉线兜底、云端多设备同步和验收闭环。**

---

## 五、如果只挑 3 件事继续做，建议优先级

| 优先级 | 事项 | 为什么 |
|---|---|---|
| P0-验收 | **跑 12h/24h daemon dogfood** | 工具已具备，需要真实数据验证关浏览器后任务、通知、watchdog 是否稳定 |
| P0-验收 | **daemon 掉线/恢复兜底体验** | 用户需要知道本地 agent 是否在线、如何恢复、是否需要 fallback |
| P1 | **验收闭环产品化** | 交付包已有基础页面，下一步要让用户能确认完成、要求返修、追踪目标达成 |

---

## 六、截至本次更新仍未完成的清单

| 优先级 | 未完成项 | 当前缺口 | 建议下一步 |
|---|---|---|---|
| P0-验收 | daemon 长时间离线执行验收 | dogfood 脚本已补，但缺真实 12h/24h 运行样本 | 建立固定验收目标，跑 12h/24h，记录完成率、通知投递率、watchdog 暂停率 |
| P0-体验 | daemon 掉线/恢复兜底 | 后台主链路已成立，但用户还缺"agent 是否在线"的明确感知 | 增加 daemon health 状态、掉线提示、重启引导和必要 fallback |
| P1 | 云端多设备同步 | 本机多 tab 已靠 BroadcastChannel 闭环，跨设备还没有 Tunnel Hub / WSS 下行 | 等本地稳定后接入 Reverse Tunnel 控制面事件通道 |
| P1 | 验收闭环产品化 | 有任务验收/修复计划，但没有形成稳定用户流程 | 把验收状态、返修、确认完成串成明确 UI 流程 |
| P2 | 多 Agent 协同 | 仍是单 Agent 顺序执行 | 先做只读 researcher / executor 分工试点，再考虑并行编排 |
| P2 | 云迁移抽象层深化 | Database / Storage / Runtime adapter 已有种子接口，但全仓还没完全替换到接口层 | 本地形态稳定后逐步把 DB/Storage/Runner 调用迁移到 adapter |

---

## 附：评估锚点对照表

| 立项主线 | 当前达成度 | 主要差距 |
|---|---|---|
| 对话入口（闲聊 / `/goal`） | 🟢 高 | — |
| 目标规划（澄清 → 拆解 → 任务） | 🟢 高 | — |
| 任务自动执行 | 🟢 高 | daemon 已成唯一主链路，缺 12h/24h 稳定性验收样本 |
| 多容器结果回流 | 🟡 中高 | 本机多 tab 已补，仍缺云端多设备事件通道和深层联动语义 |
| 本地常驻运行时 | 🟡 中高 | daemon 已成唯一写入者，离线/崩溃兜底仍需产品化 |
| 多模态可交付物 | 🔴 低 | 仅完成 Markdown/Excel 一档 |
| 多 Agent 协同 | 🔴 低 | 仅停留在调研阶段 |
| 验收 / 目标达成闭环 | 🟡 中低 | 目标交付包已有基础页面，缺确认完成/返修/验收闭环 |

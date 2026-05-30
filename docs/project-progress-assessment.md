# KiKi 项目进展评估（产品视角）

> 评估时间：2026-05-29
> 最近更新：2026-05-29（P0 本地收口实现后）
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

### ✅ 6. P0 本地收口与云迁移预备（达成度中高）
- runtime environment / schedule event 已切到命令式 API：浏览器不再通过 `/api/runtime/state/sync` 反向覆盖服务端快照
- `/api/runtime/state/sync` 路由与 `syncRuntimeStateSnapshot` helper 已删除，浏览器状态定位为 projection-only
- 协议归一已下推到 server 出口：`normalizeAwaitingInteraction` / `normalizeResultHeadline` 负责提前消除 question / snippet / field question 的重复
- `awaitingDisplayModel.ts` 已降级为展示 selector，不再承担主要语义去重
- 本轮修复后 `pnpm tsc --noEmit`、`pnpm test:planning`、`pnpm lint` 均通过

### ✅ 7. 产物可交互（达成度中）
- Markdown 表格 → `.xlsx` 自动派生 + 在线编辑器 + 下载导出，已经接近"小应用"的雏形

---

## 三、和最初预期还有差距的部分

### ⚠️ 1. "脱离浏览器自动跑"——工程主链路已下沉，产品验收还没完成
**最初预期**：关掉浏览器，KiKi 也能在后台推进任务，回来就看到收件箱里堆好结果。

**最新现状**：
- 浏览器侧 Scheduler 已经默认关闭，daemon scheduler / notification worker / watchdog 已成为主要执行路径
- 事件日志、命令式 API、runtime snapshot 回灌已形成后台执行的基础闭环
- 仍缺少长时间 dogfood 验收：需要证明关浏览器 12h/24h 后任务完成率、通知投递率、watchdog 暂停行为都稳定
- daemon 离线/崩溃后的产品兜底体验还不完整，例如用户如何知道 daemon 掉线、如何恢复、是否需要浏览器 fallback

> **PM 视角**：这块已经从"还没主导执行"推进到"主链路已具备，但缺真实长期运行验收"。下一步重点不是再重写，而是压测和兜底。

### ⚠️ 2. 状态边界——核心写路径已收口，但多端一致性还没完全产品化
**最初预期**：服务端是事实源，前端只是视图。

**最新现状**：
- goal、runtime environment、schedule event 的关键写动作已经基本切到命令式 API
- `/api/runtime/state/sync` 反向同步路由已删除，浏览器不再作为 runtime/schedule 的权威写入口
- `runtimeEnvStore` / `scheduleStore` 仍保留 Zustand persist，但定位已变成 projection-only：用于本地反馈和兜底，而不是最终事实源
- 仍缺少完整的多端实时同步闭环：runtime env / schedule event 写入后，其他 tab 主要依赖 snapshot 拉取或未来补 BroadcastChannel / 专用事件通道

> **PM 视角**：这块已经从"架构性风险"降级为"一致性体验待补"。单机本地使用已经更稳，但云端/多设备场景还没完全准备好。

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
- 浏览器 persist 里的旧数据如果没有经过 server 归一，仍可能短期出现旧格式重复
- LLM Prompt 还没有显式禁止重复输出，目前主要靠 server 出口兜底
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
- 缺少跨任务成果聚合（一个目标 6 个任务跑完，没有统一交付物）
- 缺少质量校验（任务自评 / 用户验收闭环虽然有 `task-acceptance-repair-plan.md`，但还没闭环到产品上）
- 任务完成 ≠ 目标达成，这层语义还没建模

---

## 四、一句话总结

> **KiKi 现在是个"能从模糊目标拆出可执行计划、并把任务跑通、把结果回流到多个产品容器"的可演示 Agent 原型。**
> **P0 本地收口后，它已经更接近"服务端/daemon 是事实源、浏览器只是视图"的形态；但还没完全成为"关掉浏览器也稳定替你工作、跨设备一致、目标级交付闭环清晰"的目标 OS。**

---

## 五、如果只挑 3 件事继续做，建议优先级

| 优先级 | 事项 | 为什么 |
|---|---|---|
| P0-收尾 | **多端一致性与事件通道补齐** | runtime/schedule 已切命令式 API，但其他 tab/未来云端还需要更确定的刷新机制 |
| P0-收尾 | **daemon 离线执行验收** | 需要用 12h/24h dogfood 验证关浏览器后任务、通知、watchdog 是否稳定 |
| P1 | **可交付物聚合 + 验收闭环** | 让"目标完成"有一个明确的产品出口，而不只是"任务跑完了" |

---

## 六、截至本次更新仍未完成的清单

| 优先级 | 未完成项 | 当前缺口 | 建议下一步 |
|---|---|---|---|
| P0-收尾 | daemon 长时间离线执行验收 | 工程链路已下沉，但缺 12h/24h dogfood 数据证明 | 建立一组固定目标，记录任务完成率、通知投递率、watchdog 暂停率 |
| P0-收尾 | runtime/schedule 多 tab 实时同步 | 写入已走命令式 API，但其他 tab 主要依赖 snapshot 收敛 | 加 BroadcastChannel 触发 `refreshSnapshot()`，或补 runtime/schedule 事件流 |
| P0-收尾 | snapshot 乐观锁 | `stateSnapshot.ts` 支持 `expectedRevision`，但新 service 未使用，仍是 last-write-wins | 命令 API 带 revision，冲突返回 409 并提示刷新 |
| P0-收尾 | 旧 persist 数据迁移 | 历史浏览器缓存未必经过 server 协议归一 | 增加一次性 hydrate migration 或清理提示 |
| P1 | LLM Prompt 显式禁止重复输出 | 当前主要靠 server 出口兜底 | 在任务结果 / awaiting 协议 prompt 中加入"同一问题只填一个字段"硬规则并加 spec |
| P1 | 目标级交付物聚合 | 单任务有结果，但目标完成后缺统一交付页/交付包 | 设计 goal deliverable 汇总模型，跑通一个端到端目标 |
| P1 | 验收闭环产品化 | 有任务验收/修复计划，但没有形成稳定用户流程 | 把验收状态、返修、确认完成串成明确 UI 流程 |
| P2 | 多 Agent 协同 | 仍是单 Agent 顺序执行 | 先做只读 researcher / executor 分工试点，再考虑并行编排 |
| P2 | 云迁移抽象层 | 已有 service 边界，但 DB/Storage/Runner adapter 还没抽 | 等本地形态稳定后再抽 Database / Storage / Runtime 三层接口 |

---

## 附：评估锚点对照表

| 立项主线 | 当前达成度 | 主要差距 |
|---|---|---|
| 对话入口（闲聊 / `/goal`） | 🟢 高 | — |
| 目标规划（澄清 → 拆解 → 任务） | 🟢 高 | — |
| 任务自动执行 | 🟡 中高 | daemon 主链路已具备，缺 12h/24h 稳定性验收 |
| 多容器结果回流 | 🟡 中 | 通而不深，缺联动语义与多端实时同步 |
| 本地常驻运行时 | 🟡 中高 | daemon 已成主路径，离线/崩溃兜底仍需产品化 |
| 多模态可交付物 | 🔴 低 | 仅完成 Markdown/Excel 一档 |
| 多 Agent 协同 | 🔴 低 | 仅停留在调研阶段 |
| 验收 / 目标达成闭环 | 🔴 低 | 任务完成 ≠ 目标完成 |

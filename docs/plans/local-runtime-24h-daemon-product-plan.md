# 本地 Runtime 24h 在线产品方案规划

## Summary

目标：把当前依赖“浏览器发起请求时临时拉起本地 CLI”的 KiKi，本地运行模式升级为“用户电脑上有一个可常驻的本地 Runtime Daemon”，即使浏览器关闭，仍可 24h 在线待命，并在用户重新打开网页、从其他入口发起请求、或云端有待执行任务时，随时唤醒本地 Claude CLI 执行。

本方案聚焦 `macOS` 首版，采用“本地守护进程 + 云端控制面/消息转发 + Web 前端”的三层架构：

- 本地守护进程：负责常驻、心跳、接收任务、拉起 Claude CLI、写回执行结果
- 云端控制面：负责设备注册、在线状态、任务队列、消息转发、重试与通知
- Web 前端：负责会话 UI、设备状态可视化、唤醒/绑定/授权、结果展示

核心产品目标：

- 浏览器关闭后，本地 Runtime 仍在线
- 用户重新打开 KiKi 时，可看到设备仍在线、最近心跳、最近任务结果
- 云端可将“新的用户请求 / 后台任务 / 计划触发任务”下发给本地设备执行
- 同一会话仍沿用现有 `Claude CLI --resume <sessionId>` 机制保持上下文连续
- 保持现有 `buildClaudeEnv()` 的“干净环境变量”约束，避免 session 污染和宿主环境干扰

明确不做：

- 首版不解决电脑关机、合盖深度休眠时仍持续执行的问题，只提供“检测离线 + 恢复重连 + 任务补偿”
- 首版不支持多台设备同时抢占同一个默认本地 Runtime
- 首版不开放任意系统级目录执行，只允许在授权工作目录白名单内运行
- 首版不替换现有 Claude CLI 能力，只是在其外层新增常驻守护与云端编排

## Current State Analysis

### 1. 当前聊天链路是“请求时启动 CLI”，并非常驻 Runtime

- `src/app/api/claude/chat/route.ts`
  - 当前每次用户消息都直接进入 API Route，并在请求生命周期内调用 `streamClaudeCli()`
  - 请求结束后流式通道关闭，没有本地常驻进程概念
- `src/lib/server/claudeCli.ts`
  - 当前通过 `spawn(cliPath, args)` 临时拉起 Claude CLI
  - 已支持 `--resume` 续会话、`--permission-mode` 权限模式、`stream-json` 解析
  - 优点是链路已经跑通，缺点是只能“有请求时工作”，不能“无页面常驻待命”

结论：
- 当前实现是“本地 CLI 桥接器”，不是“本地 Runtime 服务”

### 2. 当前“在线状态”只是即时检测，不代表真实常驻

- `src/lib/server/runtimeEnvValidation.ts`
  - 当前只做“目录存在 / CLI 可执行 / Claude 可用性”检测
  - 返回的是瞬时健康检查，不是持续在线心跳
- `src/components/settings/RuntimeEnvironmentPanel.tsx`
  - 当前的在线状态基于 `getRuntimeEnvStatus()` 现查现显
- `src/stores/runtimeEnvStore.ts`
  - 环境列表和当前环境仅保存在浏览器 `localStorage`
  - 浏览器关闭后没有任何后台进程继续维持该状态

结论：
- 现在的“online”更像“此刻能跑通一次 CLI”，不是“设备 24h 在线”

### 3. 当前后台执行只在目标任务链路存在雏形，且依赖前端参与

- `src/components/providers/GoalSchedulerRuntime.tsx`
  - 当前调度周期依赖浏览器端 `setInterval`
  - 页面关闭后，调度立即停止
- `src/app/api/goals/tasks/execute/route.ts`
  - 已有 fire-and-forget 形态，说明项目已经开始尝试后台任务执行
- `src/lib/server/goalTelemetry.ts`
  - 当前用 `os.tmpdir()` 下的 `kiki-goal-telemetry.json` 做轻量 telemetry
  - 更适合单机临时态，不适合“24h 常驻 + 云端可见 + 可恢复”的服务端状态
- `src/lib/api/taskRuns.ts`
  - 目前结果回流依赖前端轮询 `/api/goals/tasks/progress`

结论：
- 项目已有“后台任务执行”的产品方向，但基础设施还停留在“页面在线时可观察、服务重启即中断”的阶段

### 4. 当前已有几项关键能力可直接复用

- `src/lib/server/claudeEnv.ts`
  - 已经实现干净环境变量构造，这是守护进程执行 Claude CLI 时必须保留的安全约束
- `src/lib/server/claudeSession.ts`
  - 已对 Claude session 文件路径与删除做了安全封装，可延续到守护进程的 session 管理
- `src/types/runtime.ts`
  - 已有 `RuntimeEnvironment`、`permissionMode`、`health` 等基础模型
- `src/stores/runtimeEnvStore.ts`
  - 已有“当前环境”“本地环境列表”的前端产品骨架

结论：
- 不需要推翻现有本地 Claude 接入链路，应在此基础上引入“设备层 Runtime”

## Assumptions & Decisions

### 产品决策

- 首版目标平台：`macOS`
- 产品形态：`本地守护进程 + Web 控制台`
- 在线定义：浏览器关闭后，本地 Runtime 仍持续在线，可接收新的执行请求
- 入口定义：用户主要仍从 Web 发起请求，但 Web 不再直接驱动 Claude CLI，而是通过云端控制面把任务下发给本地 Daemon
- 调度定义：后台计划任务不再依赖浏览器 `setInterval`，而改为“云端队列 + 本地设备执行”
- 会话定义：Claude 原生 session 继续放在本地，云端只持有 `sessionId`、元数据、消息索引，不上传完整本地上下文文件

### 技术决策

- 本地守护进程采用独立 Node 服务实现，长期运行于用户机器
- macOS 自动启动采用 `LaunchAgent`
- 守护进程与云端控制面保持单条长期出站连接，优先使用 `WebSocket`
- 所有来自云端的执行请求，都必须在本地再次做工作目录白名单、权限模式、设备绑定校验
- Claude CLI 调用继续复用现有 `buildClaudeEnv()`、`resolveCliPath()`、`normalizeWorkingDirectory()`、`--resume`
- 本地执行结果分为三层：
  - 实时流：写回当前会话增量结果
  - 任务态：写回结构化执行状态、错误、最后心跳
  - 审计态：写入本地日志与云端摘要日志

### 边界定义

- “24h 在线”不等于“离线也能执行”：
  - 设备断网、关机、睡眠时无法真正执行
  - 首版通过状态识别、失败补偿、恢复重连解决，而不承诺强实时
- 首版默认一位用户绑定一台“主设备”
- 多设备支持放入后续版本，避免首版引入抢占、调度歧义和 session 一致性问题

## Proposed Changes

### 1. 新增本地 Runtime Daemon 层

新增目录建议：

- `src/lib/daemon/`
- `src/bin/kiki-runtime-daemon.ts`
- `src/types/runtime-daemon.ts`

职责：

- 常驻运行，接收云端任务
- 周期性上报心跳、系统状态、CLI 可用性、当前忙闲状态
- 管理本地授权工作目录与默认 Claude CLI 路径
- 拉起 Claude CLI，执行聊天/规划/任务执行请求
- 管理本地 session 续聊和失败重试

为什么这样做：

- 现在 `src/app/api/claude/chat/route.ts` 只能在网页请求生命周期里工作
- 想要浏览器关闭后仍可执行，必须把“执行主体”从 Next.js 请求处理进程迁到用户电脑上的常驻服务

如何落地：

- 将当前 `src/lib/server/claudeCli.ts` 中“拉起 CLI + 流解析”的核心逻辑抽成可同时被：
  - Next.js API Route 调用
  - 本地 Daemon 调用
- Daemon 保存本地配置文件，例如：
  - `~/.kiki/runtime/config.json`
  - `~/.kiki/runtime/device.json`
  - `~/.kiki/runtime/logs/*.log`
- Daemon 本地暴露一个仅本机可访问的 loopback HTTP 端口，例如 `127.0.0.1:4217`
  - 用于本地诊断、状态查看、调试和首轮设备绑定

### 2. 引入 macOS LaunchAgent，实现开机/登录自动运行

新增建议：

- `scripts/generate-launch-agent.ts`
- `packaging/macos/com.kiki.runtime-daemon.plist`
- `src/app/api/runtime-envs/install-agent/route.ts`

职责：

- 让用户在“设置 -> 运行环境”中一键安装本地守护进程
- 将 Daemon 注册为用户级 `LaunchAgent`
- 支持以下状态：
  - 未安装
  - 已安装未运行
  - 运行中
  - 运行异常

为什么这样做：

- 单纯让网页定时轮询无法解决浏览器关闭问题
- macOS 首版最稳妥的 24h 在线形态是用户登录后自启动的常驻进程

如何落地：

- Web 端通过安装向导生成/安装 LaunchAgent
- Daemon 开机后：
  - 自检 Claude CLI
  - 自检授权目录
  - 向云端注册上线
  - 建立长连接

### 3. 新增云端控制面与消息转发层

新增目录建议：

- `src/app/api/runtime-control/`
- `src/lib/server/runtimeControlPlane.ts`
- `src/lib/server/runtimeQueue.ts`
- `src/types/runtime-control.ts`

职责：

- 设备注册与绑定
- 设备在线状态管理
- 用户请求转发
- 后台任务调度
- 失败重试、超时、排队、取消

为什么这样做：

- 如果只做本地守护进程但没有云端控制面，则浏览器关闭后无法“找到并唤醒”本地设备
- “随时响应用户请求”本质上需要一个稳定的中心路由，负责把用户请求派发给当前在线设备

如何落地：

- 前端不再直接命中 `src/app/api/claude/chat/route.ts` 触发 CLI
- 前端先把请求提交给控制面，控制面生成 `job`
- 在线设备通过 WebSocket 订阅自己的任务流
- Daemon 收到任务后执行，并回传：
  - `accepted`
  - `running`
  - `stream_delta`
  - `awaiting_user`
  - `completed`
  - `failed`

建议任务模型：

```ts
type RuntimeJob = {
  id: string;
  userId: string;
  deviceId: string;
  kind: "chat" | "goal_plan" | "goal_task" | "health_check";
  conversationId?: string;
  claudeSessionId?: string;
  workingDirectory: string;
  permissionMode: "readonly" | "confirm" | "execute";
  payload: Record<string, unknown>;
  status: "queued" | "assigned" | "running" | "awaiting_user" | "completed" | "failed" | "canceled";
  createdAt: string;
  updatedAt: string;
};
```

### 4. 将“运行环境”升级为“设备管理”

重点修改文件：

- `src/stores/runtimeEnvStore.ts`
- `src/components/settings/RuntimeEnvironmentPanel.tsx`
- `src/components/settings/LocalRuntimeWizard.tsx`
- `src/components/settings/RuntimeStatusBadge.tsx`
- `src/types/runtime.ts`

改动方向：

- 现有“环境”概念从“CLI 检测配置”升级为“两层模型”：
  - `RuntimeEnvironment`：执行策略与授权目录
  - `RuntimeDevice`：真实在线设备与 Daemon 状态

建议新增字段：

```ts
type RuntimeDeviceStatus =
  | "uninstalled"
  | "installing"
  | "offline"
  | "online"
  | "busy"
  | "degraded";

type RuntimeDevice = {
  id: string;
  name: string;
  platform: "macos";
  daemonVersion?: string;
  daemonInstalled: boolean;
  launchAgentInstalled: boolean;
  status: RuntimeDeviceStatus;
  lastHeartbeatAt?: string;
  lastSeenIp?: string;
  boundRuntimeEnvId?: string;
  currentJobId?: string;
};
```

UI 升级重点：

- 当前设置页除了“CLI 是否可用”，还要展示：
  - 设备是否已安装守护进程
  - LaunchAgent 是否已启用
  - 最近心跳时间
  - 当前忙闲状态
  - 最近一次执行结果
  - 是否允许浏览器关闭后继续响应
- 新增一键操作：
  - 安装守护进程
  - 重启守护进程
  - 重连设备
  - 查看日志
  - 解绑设备

为什么这样做：

- 用户需要感知的已经不再是“本地 Claude 配置项”，而是“这台电脑是不是随时在线、可不可以接活”

### 5. 重构聊天链路：从“网页直连 CLI”改为“网页 -> 控制面 -> Daemon”

重点修改文件：

- `src/app/api/claude/chat/route.ts`
- `src/lib/api/claude.ts`
- `src/stores/assistantStore.ts`
- `src/components/layout/AssistantSidebar.tsx`
- `src/components/conversation/ConversationView.tsx`
- `src/stores/conversationStore.ts`

改动方向：

- `src/app/api/claude/chat/route.ts`
  - 从“直接拉起 Claude CLI”改为“兼容模式入口”
  - 首版可保留两种模式：
    - 旧模式：本地网页直连本机 CLI，供开发调试
    - 新模式：提交云端 job，由 Daemon 执行
- `assistantStore`
  - 需要增加 job 概念、设备状态感知、断线提示
- `ConversationView`
  - 流式展示来源从“Next.js Route 的 SSE”切换为“控制面/消息总线的 SSE”

为什么这样做：

- 只有把执行从浏览器会话解绑，聊天能力才能在页面关闭后仍保持“可被重新接续”的在线体验

建议交互变化：

- 用户发送消息时，如果设备在线：
  - 立即显示“已发送到本地 Runtime”
  - 若设备忙，显示“排队中”
  - 开始显示流式回复
- 如果设备离线：
  - 提供“等待设备上线后自动执行”或“改为云端回答（后续能力）”的明确分流

### 6. 将目标调度从前端 `setInterval` 迁到控制面/Daemon

重点修改文件：

- `src/components/providers/GoalSchedulerRuntime.tsx`
- `src/lib/api/taskRuns.ts`
- `src/app/api/goals/tasks/execute/route.ts`
- `src/app/api/goals/tasks/progress/route.ts`
- `src/lib/server/goalTaskRunner.ts`
- `src/lib/server/goalTelemetry.ts`

改动方向：

- `GoalSchedulerRuntime.tsx`
  - 不再承担真实调度职责
  - 仅负责订阅状态变化、刷新 UI、展示待处理项
- 真实调度迁移到：
  - 云端控制面：做任务编排和排队
  - 本地 Daemon：做本机执行和状态汇报
- `goalTelemetry.ts`
  - 从 `os.tmpdir()` 单文件临时态升级为：
    - 本地 Daemon 持久日志
    - 云端任务摘要日志

为什么这样做：

- 现在只要页面关闭，后台任务调度就中断，这与“24h 在线项目”目标冲突

建议新职责划分：

- 云端：
  - 决定什么时候该执行哪个任务
  - 为任务分配到哪个设备
  - 记录任务状态
- 本地：
  - 真正执行 Claude CLI
  - 上报日志、进度、等待用户确认等事件

### 7. 新增设备注册、心跳、断线补偿机制

新增建议文件：

- `src/app/api/runtime-control/register/route.ts`
- `src/app/api/runtime-control/heartbeat/route.ts`
- `src/app/api/runtime-control/jobs/route.ts`
- `src/app/api/runtime-control/jobs/[jobId]/events/route.ts`

机制设计：

- 设备注册
  - 安装守护进程后，生成 `deviceId + deviceSecret`
  - 与当前登录用户绑定
- 心跳
  - 每 `15-30s` 上报一次：
    - 在线状态
    - 当前任务数
    - CLI 可用性
    - 当前工作目录授权集
- 断线判断
  - 超过 `60-90s` 无心跳，标记为 `offline`
- 任务补偿
  - `queued` 状态保留，等待设备上线
  - `running` 状态如果设备断线，则标记 `interrupted`，允许用户恢复或重跑

为什么这样做：

- 没有心跳，前端看到的“在线”就不可信
- 没有补偿，任何断网/重启都会让 24h 在线体验变成“假在线”

### 8. 建立本地安全沙箱与授权模型

重点沿用并扩展文件：

- `src/lib/server/claudeEnv.ts`
- `src/lib/server/runtimeEnvValidation.ts`
- `src/types/runtime.ts`

安全原则：

- 守护进程执行 Claude CLI 时仍只注入白名单环境变量
- 所有 job 必须映射到用户已授权的工作目录
- `execute` 模式只能在授权目录内生效
- 云端不能直接下发任意 shell 命令；必须下发结构化任务，由本地执行器二次校验

建议新增约束：

- 每个 job 均携带：
  - `allowedWorkingDirectory`
  - `runtimeEnvId`
  - `permissionMode`
  - `requestedTools`
- 本地 Daemon 若发现越权：
  - 直接拒绝执行
  - 回传 `failed / denied_by_policy`

### 9. 保留一条“开发兼容模式”，避免首版切换风险过大

涉及文件：

- `src/app/api/claude/chat/route.ts`
- `src/lib/server/claudeCli.ts`
- `src/lib/api/claude.ts`

设计方式：

- 增加运行策略枚举：

```ts
type RuntimeExecutionTransport = "direct_local_bridge" | "daemon_control_plane";
```

- 开发环境默认可继续使用旧链路
- 生产/目标首版切到新链路

为什么这样做：

- 当前仓库里的对话、目标规划、任务执行都直接依赖现有 Claude CLI 桥接
- 若一次性硬切，会让调试和联调成本非常高
- 兼容模式能降低演进风险

## Product Flow

### Flow 1：首次接入

1. 用户进入 `设置 -> 运行环境`
2. 扫描到本地 Claude CLI，完成目录授权
3. 点击“安装 24h 在线 Runtime”
4. Web 调起本地安装流程，注册 LaunchAgent
5. Daemon 首次启动，生成 `deviceId`
6. 用户在网页确认设备绑定
7. 设备开始持续心跳，状态变为“在线”

### Flow 2：浏览器关闭后仍在线

1. 用户关闭网页
2. Daemon 继续保持运行与心跳
3. 云端控制面仍显示设备在线
4. 新请求到来时进入 job 队列
5. 在线设备立即领取并执行
6. 用户下次打开网页时，可看到最近结果和未读状态

### Flow 3：用户重新打开网页继续同一会话

1. 前端拉取该会话最近 job 与 message 索引
2. 若上一轮由本地 Daemon 执行完成，则直接展示结果
3. 若会话继续提问，则新 job 复用已有 `claudeSessionId`
4. 本地 Claude 通过 `--resume <sessionId>` 保持连续上下文

### Flow 4：设备离线

1. 控制面检测到心跳超时
2. 设置页与聊天输入框顶部显示“本地 Runtime 离线”
3. 用户可选择：
  - 等待上线自动执行
  - 手动重连
  - 切换到其他运行模式（后续版本）

## Edge Cases & Failure Modes

必须显式覆盖：

- Daemon 未安装：引导安装，不允许承诺 24h 在线
- LaunchAgent 安装成功但进程未运行：展示“已安装未启动”，提供一键重启
- Claude CLI 升级或路径变化：心跳里上报 `degraded`
- 用户修改工作目录权限：后续 job 被拒绝，并提示重新授权
- 设备断网：job 留在 `queued`
- 执行中掉线：job 标记 `interrupted`
- Claude session 损坏：允许用户手动重建本地 session
- 本地磁盘日志过大：Daemon 定期轮转压缩
- 多标签页同时发消息：控制面负责串行化或排队，避免本地 session 竞争

## Rollout Plan

### Phase A：能力验证

- 目标：先跑通“网页请求 -> 控制面 -> 本地 Daemon -> Claude CLI -> 回流结果”
- 范围：只支持聊天，不支持目标调度
- 成功标准：
  - 浏览器关闭后，设备状态仍在线
  - 重新打开网页后可看到最近一次结果

### Phase B：设备管理产品化

- 目标：完成安装向导、状态页、心跳、日志、重连
- 范围：接入设置页完整 UI
- 成功标准：
  - 用户能自主安装/诊断/修复本地 Runtime

### Phase C：目标任务迁移

- 目标：把 `GoalSchedulerRuntime.tsx` 的真实调度职责迁出浏览器
- 范围：`goal_task` 和 `goal_plan` 统一走 job 模型
- 成功标准：
  - 页面关闭后，计划任务仍能按规则执行

### Phase D：可靠性增强

- 目标：补充重试、断点恢复、任务补偿、日志聚合、异常告警
- 成功标准：
  - 网络抖动或 Daemon 重启后，任务状态仍可恢复

## Metrics & Acceptance Criteria

关键指标：

- 设备日在线率
- 心跳成功率
- job 分发成功率
- job 首字返回时延
- 断线恢复时长
- 因本地授权/环境问题导致的失败率

首版验收标准：

- 用户安装后，macOS 登录态下守护进程自动运行成功率 > 95%
- 浏览器关闭 30 分钟后重新进入，设备仍能显示最近心跳
- 新消息可在在线设备上 5 秒内开始执行
- 会话连续两轮以上可稳定复用 `claudeSessionId`
- 设备离线时，UI 能明确提示，不出现“显示在线但实际不可执行”的假状态

## Verification Steps

### 产品验证

- 在 `设置 -> 运行环境` 完成本地 Runtime 安装
- 关闭浏览器后等待 5 分钟，再重新打开页面
- 验证设置页仍显示：
  - 设备在线
  - 最近心跳时间更新正常
  - LaunchAgent 已启用

### 聊天验证

- 关闭原有聊天页
- 从新打开的页面发送一条消息
- 验证该消息不是由网页本地直接拉起 CLI，而是由在线 Daemon 领取执行
- 验证结果可正常流式显示

### 中断恢复验证

- 在任务执行中手动停止 Daemon
- 验证控制面将设备标记为离线/中断
- 重启 Daemon 后验证设备重新上线
- 验证待恢复任务可重新执行或提示用户处理

### 目标任务验证

- 创建一个未来触发的目标任务
- 关闭浏览器，等待触发时刻
- 重新打开页面，验证任务已由 Daemon 执行并回流结果

### 工程验证

- 保留现有 `src/lib/server/claudeEnv.ts` 的干净环境变量策略
- 验证 `src/lib/server/claudeCli.ts` 抽象后仍兼容现有聊天与目标链路
- 后续实现阶段执行：
  - `pnpm lint`
  - `pnpm build`
  - 守护进程安装/卸载/重启的端到端手测

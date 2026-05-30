# 本地 Runtime + 云端反向通道方案

> 制定时间：2026-05-29
> 输入：用户提供的 slock-ai 风格连接命令截图
> 目的：把 KiKi 从"纯本地 Agent"演进为"云端控制面 + 用户本地 Runtime"的混合形态
> 关键约束：**Claude CLI 继续留在用户本地，登录态用户自管**；云端只做"控制面 + 视图层"

---

## 一、目标形态（参考图原理）

用户在自己机器上跑：

```
npx @kiki/daemon@latest \
  --server-url https://api.kiki.app \
  --api-key sk_machine_xxxxxxxxxxxxxxxx
```

这条命令做的事：

1. 在本机起一个 **daemon 进程**
2. daemon **主动**向云端 API 建立一条 **长连接**（WebSocket）
3. 云端拿到这条"反向通道"后，能在用户**不开端口、不暴露公网 IP** 的情况下远程指挥本地 daemon
4. 云端每个 user/machine 用 `api-key` 认证、隔离

> 这是经典的 **Reverse Tunnel / Outbound Connect** 模式，与 ngrok、Tailscale、Cloudflare Tunnel、GitHub Self-Hosted Runner、VSCode Remote Tunnel、JetBrains Gateway 同源。

---

## 二、与 KiKi 当前架构的契合度

✅ **天然契合**——KiKi 现有的本地运行时已经是这个形态的雏形：

| KiKi 现有件 | 对应这套架构里的角色 |
|---|---|
| `kiki-runtime-daemon.ts` | daemon 主体 |
| `runtime_jobs` 表 + Worker | 本地任务执行队列 |
| `runtimeEnvironment` 概念 | "machine" 概念（粒度需重定义） |
| Claude CLI spawn | daemon 控制下的具体 runtime |
| `device.json` / `state.json` | 本地身份 / 心跳状态 |

**现状缺 3 件**：
1. 没有云端控制面（API server）
2. daemon 是被前端拉起的，没有"主动连云"的反向通道
3. 没有 machine 维度的认证（`api-key`）

---

## 三、推荐的目标架构

```
┌─────────────────────────────────────────────────┐
│  用户浏览器                                        │
└──────────────┬──────────────────────────────────┘
               │ HTTPS
               ↓
┌─────────────────────────────────────────────────┐
│  Cloudflare Pages（前端 + 边缘 API）              │
│  - 静态 / SSR / 轻 API                            │
└──────────────┬──────────────────────────────────┘
               │ HTTPS / WSS
               ↓
┌─────────────────────────────────────────────────┐
│  Railway · 控制面（Control Plane）                │
│  ┌─────────────────────────────────────────┐    │
│  │  API Server（命令分发、事件聚合）          │    │
│  │  Postgres（goals / events / machines）   │    │
│  │  R2（artifacts / traces）                 │    │
│  │  Tunnel Hub（WebSocket 接入）             │    │
│  └─────────────────────────────────────────┘    │
└──────────────▲──────────────────────────────────┘
               │
               │ WSS（持久长连，daemon 主动 outbound）
               │ - 心跳
               │ - 任务下发：execute(taskId, input)
               │ - 结果上行：events / artifacts
               │ - 文件分块上传
               ↑
┌─────────────────────────────────────────────────┐
│  用户本机                                          │
│  ┌──────────────────────────────────────────┐  │
│  │  KiKi Daemon                              │  │
│  │  - 启动命令：npx @kiki/daemon ...         │  │
│  │  - 反向连接 WSS                            │  │
│  │  - 本地执行 Claude CLI                     │  │
│  │  - 本地工作区 fs                            │  │
│  └──────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

**核心反转**：daemon 不再是"被 Next 拉起的本地进程"，而是 **"用户机器主动注册到云端的远程执行节点"**。

---

## 四、技术选型对照（连接方式）

| 方案 | 适合度 | 说明 |
|---|---|---|
| **WebSocket（自建）** | 🟢 推荐 | 轻、可双向、Railway/CF 都有原生支持；与 SSE 同模型 |
| Cloudflare Tunnel | 🟡 可选 | 走 CF 自家通道更稳；但 daemon 要装 cloudflared 二进制，体验偏重 |
| gRPC bi-stream | 🟡 可选 | 强类型、流控好；但浏览器/CF Worker 端不友好 |
| HTTP long-poll | 🔴 不推荐 | 实时性差、连接管理复杂 |
| SSH Reverse Tunnel | 🔴 不推荐 | 用户体验差、依赖端口 |

> **建议**：**WebSocket + JSON-RPC（或自定义事件协议）** 最匹配 KiKi 现有事件流模型，复用 `goal_event_log` 协议即可。

---

## 五、和现有 P0 路线的整合

### 5.1 复用项（不重做）

- ✅ **goal_event_log（P0-A）**：daemon 上行的所有进度/结果/工件 → 直接 append 进事件流
- ✅ **命令式 API（P0-A Sprint 3）**：API 收到用户命令后，转发到 daemon 的 WS 通道
- ✅ **协议归一（P0-B）**：daemon 上行前先归一，云端不用再处理脏数据

### 5.2 需要新增的能力

| # | 能力 | 工时估算 |
|---|---|---|
| C-1 | Machine 注册与认证（`api-key` 生成/吊销，machine 表） | 2-3 天 |
| C-2 | Tunnel Hub：WebSocket 接入 + 心跳 + 鉴权 + 路由 | 4-5 天 |
| C-3 | Daemon 改造：从"本机被调用"改为"主动 outbound 连云" | 3-4 天 |
| C-4 | 命令分发器：API 命令 → 找到该 user 的活 machine → 投到对应 WS | 2-3 天 |
| C-5 | 结果上行管道：daemon 把事件/artifact 推回云端事件流 | 3 天 |
| C-6 | 离线降级：machine 离线时的命令排队、超时返回 | 2 天 |
| C-7 | 多 machine 选择策略：用户有多台机器时的路由 UI / 默认机 | 2 天 |
| C-8 | 安全加固：api-key rotate、IP 限频、命令白名单 | 2-3 天 |
| C-9 | Daemon 打包发布：`npx @kiki/daemon` 包发布到 npm + 自更新 | 3 天 |

合计 **约 23-28 个工作日**（4-5 周）。

---

## 六、关键设计决策

### 6.1 通信协议骨架

```
Client → Server  (daemon 上行)
  • register      { machineId, os, runtimes[], daemonVersion }
  • heartbeat     { ts, load, runningJobs[] }
  • event         { eventId, kind, payload }     ← 直接用 goal_event_log 协议
  • artifactChunk { uploadId, seq, data }

Server → Client  (云端下行)
  • execute       { instanceId, taskPayload, idempotencyKey }
  • cancel        { instanceId, idempotencyKey }
  • respond       { instanceId, userResponse }
  • configUpdate  { runtimePolicy, toolPolicy }
```

### 6.2 文件 / Artifact 处理

用户的产物本来就在**本地 workspace**，云端要展示就需要：
- **小文件（< 1MB）**：daemon 直接通过 WS 分块推到云端 R2
- **大文件 / 实时预览**：daemon 提供 **本地 HTTP 预览端点**（127.0.0.1:port），通过 WS 隧道转发，类似 VSCode Tunnels 的 forward port

### 6.3 多设备与离线

- 用户在 web 上操作 → API 看 machine 状态：
  - 在线 → 直接下发
  - 离线 → 排队（写入 `pending_commands` 表），machine 上线时回放
- machine 列表 UI：参考图中样式（machine 名 / OS / 在线状态 / 已检测到的 runtime / 连接命令）

### 6.4 安全模型

- **api-key 一机一密**，绑定 user
- daemon 启动时校验 key + machineId
- WS 帧级鉴权（每条消息带签名）
- **本地敏感数据不主动上传**（artifact 用户主动触发才上传）
- **危险命令双重确认**（Bash / 写文件等通过权限策略 + 云端策略双层）

---

## 七、改造路径（建议分阶段）

### 阶段 0：架构抽象（与 P0-A/B 并行，1-2 周）
- 把 `runner / storage / db` 三层抽象出去，让 daemon 既能"自己跑 web UI"也能"作为远程节点跑"
- 这步与云迁移评估里的 0-1/0-2/0-3 完全重合

### 阶段 1：本地"自闭环 + 远程模式"双形态（2 周）
- daemon 增加 `--remote` 启动模式
- 本地直跑模式保留（向后兼容现有用户）
- 远程模式连一个最小 Tunnel Hub（甚至先连本地 mock server）

### 阶段 2：云端控制面 MVP（2 周）
- Tunnel Hub 上线 Railway
- Cloudflare Pages 跑前端，machine 列表页（参考图）
- 用户走完"装 CLI → 复制连接命令 → web 看到自己 machine 在线 → 发起任务"全链路

### 阶段 3：能力补齐（2 周）
- artifact 上传 / 离线队列 / 多机选择 / api-key rotate / 安全加固

合计 **约 6-8 周**（含与 P0-A/B 重叠部分）。

---

## 八、需要现在就决定的 4 件事

| # | 决策项 | 选项 | 推荐 |
|---|---|---|---|
| D1 | 通道协议 | WebSocket / gRPC / Cloudflare Tunnel | **WebSocket（自建）**——最轻、与现有事件流一致 |
| D2 | machine 概念是否复用现有 `runtimeEnvironment` | 复用 / 重建 | **重建**——`runtimeEnvironment` 是 CLI 路径粒度，machine 是物理机粒度，两者一对多 |
| D3 | daemon 发布渠道 | npm / brew / 独立安装包 | **npm + 自更新**（与图里同款）+ **dmg 安装器**（小白用户） |
| D4 | 第一版只支持单机还是多机 | 单机 / 多机 | **第一版单机**——简化路由，把多机做成 V2 |

---

## 九、与现有 P0 计划的衔接

| 当前计划 | 调整建议 |
|---|---|
| P0-A Sprint 1 建 `goal_event_log` 表 | **先做架构抽象**（DB / Storage / Runner），再用抽象层建表；避免 Sprint 1 后又拆一次 |
| P0-A Sprint 2 daemon 补 watchdog/通知投递 | daemon 概念立刻分两层：**调度核心 + 部署形态**；本地用 LaunchAgent，云上用 Tunnel 反向连，**同一份核心代码** |
| P0-A Sprint 3 命令式 API | 命令式 API 设计原则增加："必须能透传到本地 daemon" |
| P0-B 协议归一 | 协议归一函数纯函数，无影响；daemon 上行前调用一次，云端写入再调用一次（双层兜底） |
| 新增 P0-C？ | 建议立项 **P0-C：本地 Runtime + 云端反向通道**，与 P0-A/B 并行 1-2 周后融合 |

---

## 十、风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| **WS 长连接稳定性**（NAT/防火墙/休眠） | machine 频繁掉线 | 心跳 + 自动重连 + 指数退避；离线命令队列兜底 |
| **api-key 泄漏** | 别人拿 key 冒充 machine 注册 | machine 首次注册时绑定指纹（机器码 + OS）；二次同 key 不同指纹拒绝 + 通知用户 |
| **本地 Claude CLI 登录态丢失** | 任务执行失败 | daemon 启动时做 `claude --version` + 简单调用探测；失败时上报"runtime unhealthy" |
| **大文件上传带宽** | 用户网速差时体验差 | artifact 默认懒上传，预览走 tunnel 转发；用户主动"导出到云"才走 R2 |
| **daemon 自更新失败** | 版本碎片化 | 服务端兼容 N-2 版本；不兼容时强制提示用户重装；提供"通过 web 推送更新命令" |
| **多机同时执行同一任务** | 重复消耗 | 命令带 `idempotencyKey` + 服务端 lease 仅授一台机器 |
| **隐私边界** | 用户担心代码/文件被云端拿走 | 默认"本地主权"：除事件流元数据外，artifact 必须用户显式同意才上传；提供 `--privacy strict` 模式只上传 metadata |

---

## 十一、验收指标（MVP）

| 指标 | 目标 |
|---|---|
| 复制命令到 web 可见 machine 在线的时长 | ≤ 10 秒 |
| machine 重连成功率（断网恢复后） | ≥ 99% |
| 命令下发到 daemon 收到的延迟（p50） | ≤ 300ms |
| 事件上行到 web 可见的延迟（p50） | ≤ 500ms |
| 离线 → 上线后命令重放成功率 | ≥ 99% |
| Daemon 内存占用（空闲态） | ≤ 80 MB |
| Daemon 安装到首次连接成功的"首跑成功率" | ≥ 95% |

---

## 十二、不在本方案范围内（明确划出去）

- ❌ Claude CLI 上云端（明确保留在本地）
- ❌ Anthropic API 直连模式（保留为未来选项，本方案不做）
- ❌ 多 Agent 并行协同（独立方案）
- ❌ Web IDE / 在线编辑器（参考 VSCode Tunnels，本方案不做）
- ❌ 收费 / 计量系统（产品商业化方案，独立讨论）

---

## 十三、一句话给老板

> 这套"用户本地装 daemon、云端通过反向通道远程控制"的模式（slock / VSCode Tunnels / GitHub Runner 同源），**与 KiKi 现有架构高度契合**——我们已经有 daemon、有 runtime job 队列、有事件流，只差**一条云端长连接**和**machine 注册认证**。
> 改造可以与正在做的 P0-A（事件流）、P0-B（协议归一）**完全复用**底座，额外约 4-5 周可以走完 MVP（用户复制命令 → 装 daemon → web 看到自己 machine → 在线发任务、看进度、收回工件）。
> Claude CLI 继续留在用户本地、登录态用户自管，云端只做"控制面 + 视图层"，**完美契合 Cloudflare + Railway 的部署蓝图**：Cloudflare 做前端和轻 API，Railway 做 Tunnel Hub 和事件聚合，本地 daemon 做执行。

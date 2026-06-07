# 账号体系与租户隔离方案

## 1. 目标与边界

为当前「无账号、单一全局数据」的系统引入真实账号体系：

- **认证**：邮箱 + 密码 注册 / 登录 / 登出，httpOnly session cookie。**开放注册**（无邀请码/白名单）。
- **隔离**：每个账号一套**物理独立的数据根目录**（独立 `kiki.db` + `storage`），账号之间天然零串户。
- **执行模型**：claude CLI 留在**用户本地电脑**，用户自带 key；云端不跑 claude，仅做控制面 + 视图层，通过反向通道（local daemon outbound WSS）指挥本地执行。详见 [local-runtime-cloud-tunnel-plan.md](./local-runtime-cloud-tunnel-plan.md)。
- **部署**：Railway 云端多用户，**单 service + 单持久化 Volume**（见 §7 对 Railway 卷限制的论证）。
- **认证范围**：本地邮箱密码起步（不引入第三方 OAuth）。

非目标（本期不做）：邮箱验证 / 找回密码 / 多设备会话管理 / 组织与团队 / RBAC 角色。预留扩展位但不实现。

### 1.1 关键决策记录（已与用户对齐）

| # | 决策项 | 结论 |
| --- | --- | --- |
| D1 | Web 与执行进程拓扑 | 原倾向「两 service 共享 Volume」**经查证 Railway 不支持**；因执行下沉本地，云端收敛为**单 service 单 Volume**，问题消解 |
| D2 | 并发预算模型 | **两层**：每用户独立并发上限 N_user + 全局总闸 N_global，两者同时生效 |
| D3 | claude CLI 多租户 | **每用户连接各自本地电脑的 CLI、用自己的 key**；云端负责建立云↔本地通信（slock-ai 风格反向通道） |
| D5 | 注册策略 | **开放注册**（但必须配套防滥用：注册限速 + per-user 存储软上限 + 卷用量监控，见 §8） |
| D6 | 邮箱真实性 | 不验证邮箱、暂可接受（忘密码=丢账号，本期无找回）。**已知副作用**：可抢注他人邮箱，未来加邮箱验证/找回需先处理历史抢注数据 |
| D7 | 旧本地数据 | **可直接 reset**，不做 legacy 迁移脚本 |
| D8 | 身份传递方式 | userId **只**由 `withAuth()` 在 Node runtime 内从已校验 session 派生，**不经任何请求头传递**；middleware 仅做"无 cookie → 跳转"的轻校验（见 §5.4，修正早期"注入 x-user-id"的错误设计） |
| D9 | daemon 形态 | **同一份核心代码、两种部署形态**：本地执行形态（spawn claude CLI）/ 云端编排形态（不 spawn，仅下发与投影）。靠启动模式切换，不改写同一函数（见 §6） |

## 2. 现状与冲突点

| 维度 | 现状 | 结论 |
| --- | --- | --- |
| 鉴权 | 无 middleware 鉴权、无 session；`UserMenu` 中 "Josh" 为硬编码，登出为空操作 | 需从零建认证层 |
| 业务数据 | topics/goals 存 `runtime_state_snapshots`，用全局 key `"topics"`；`conversations`/`runtime_jobs` 有 `user_id` 列但恒为 `'local-user'` 且查询不过滤 | 物理隔离后 `user_id` 列退化为审计字段，隔离靠目录 |
| 存储路径 | 全部派生自单例 `getProjectRootDataDir()`（`data/`） | 需改为「按当前用户」解析根目录 |
| 后台调度 | 独立进程；`daemonRunner` 内有**多条相互独立的 `setInterval`/启动调用**（启动自检、心跳写入、`threadLoopDaemon`、dispatch 帧、reconcile 帧），各自打开全局单 DB、`while(true)` 轮询所有 `runtime_jobs` | **最大改造点**：执行下沉本地后转为云端编排器，需把**每一条独立循环**都改成"先列用户、再逐户进上下文"，并经反向通道下发 |
| 进程内内存态 | `executionSupervisor`（进程级单例，`Map<requestId, job>`）、`threadLoopDaemon`（启动时创建一次）、可能的快照/遥测内存缓存、SSE/事件总线 | 这些**默认按进程全局共享**，物理分库无法隔离它们；需按 user 维度实例化或在 key 上带 userId（见 §4.1） |

**核心张力**：物理隔离要求"每用户一个 DB"，而调度器是跨用户的单进程编排器，且全链路深层模块都假设"全局唯一数据目录"。方案的核心是引入**用户上下文（User Context）**贯穿 HTTP 与调度两条路径。

> **隔离的两个层次**：①「磁盘/DB 层」靠物理分目录 + ALS 解析路径解决（§4）；②「进程内存态层」（单例、缓存、事件总线、定时器）**物理分库管不到**，必须单独做隔离审计（§4.1）。早期版本只覆盖了 ①，是本次补全的重点之一。

## 3. 总体架构

执行下沉到用户本地后，云端形态从「云端跑 worker」转为「云端控制面 + 本地执行节点」。账号体系负责"云端身份与隔离"，反向通道方案负责"云↔本地执行"。

```
   用户浏览器
      │ HTTPS (session cookie)
      ▼
┌──────────────────────────────────────────────────┐
│  Railway · 单 service + 单 Volume(/data)          │
│                                                    │
│  ┌────────────────────┐   ┌────────────────────┐  │
│  │ Registry DB(全局)   │   │ Per-User DB(每账号) │  │
│  │ data/system/        │   │ data/users/<uid>/   │  │
│  │  registry.db        │   │  kiki.db, storage   │  │
│  │  - users            │   │ (云端：控制面状态/   │  │
│  │  - sessions         │   │  事件流/任务编排)    │  │
│  │  - machines(api-key)│   └────────────────────┘  │
│  └────────────────────┘                            │
│  Next 路由 + withAuth → runWithUserContext(uid)    │
│  Tunnel Hub (WSS 接入，按 user/machine 鉴权路由)    │
└───────────────▲────────────────────────────────────┘
                │ WSS（本地 daemon 主动 outbound 长连）
                │  ↑ 心跳/事件/产物   ↓ execute/cancel
   ┌────────────┴───────────────────────────────────┐
   │  用户本机                                         │
   │  npx @kiki/daemon --server-url .. --api-key ..   │
   │   - 反向连接云端                                  │
   │   - 本地跑 claude CLI（用户自己的 key）           │
   │   - 本地工作区 fs（真正的执行与文件落地）          │
   └──────────────────────────────────────────────────┘
```

两个数据库层级（均在云端 Volume 上）：

1. **Registry DB（全局，唯一）**：认证、用户清单、**machine/api-key 注册表**，跨用户共享。路径 `data/system/registry.db`。
2. **Per-User DB（每账号一套）**：现有业务表，存**控制面侧**的编排状态与事件流（`runtime_jobs` 退化为"下发到本地的任务镜像"，真正执行在本地）。路径 `data/users/<uid>/kiki.db`，schema 复用现有 `KIKI_DB_BOOTSTRAP_SQL`。

> 隔离边界：云端按 `userId` 物理分目录；执行侧按 `api-key` 绑定 user 的 machine。两层身份在 Tunnel Hub 处汇合（session 的 userId 必须等于 machine 的 owner userId 才允许下发）。

## 4. 用户上下文（User Context）—— 贯穿全链路的关键机制

采用 Node `AsyncLocalStorage` 承载当前请求/任务的 `userId`，让深层的 `paths.ts` / `db/client.ts` 无需逐层透传参数即可解析到正确的数据目录。这是「单一真值、零双写」的关键：数据目录由上下文唯一决定，调用方代码几乎不动。

新增 `src/lib/server/context/userContext.ts`：

```ts
import { AsyncLocalStorage } from "node:async_hooks";

type UserContext = { userId: string };
const als = new AsyncLocalStorage<UserContext>();

export function runWithUserContext<T>(userId: string, fn: () => T): T {
  return als.run({ userId }, fn);
}

export function getCurrentUserId(): string {
  const ctx = als.getStore();
  if (!ctx) throw new Error("缺少用户上下文：未在 runWithUserContext 内调用");
  return ctx.userId;
}
```

改造 [paths.ts](../../src/lib/server/storage/paths.ts)，**关键是区分「系统路径」与「用户路径」两套函数**（这是早期版本最大的遗漏）：改完后任何调用 `getCurrentUserId()` 的地方一旦不在 `runWithUserContext` 内就会 `throw`，而 daemon 里有大量裸跑的定时器（心跳、日志、device/state、registry 读写）本就**不属于任何用户**。若让 `getProjectRootDataDir()` 强制要求上下文，这些路径会全部炸。

```ts
// 1) 计算基目录（不依赖用户上下文）
function getDataBaseDir() {
  const configured = process.env.KIKI_DATA_DIR?.trim();
  return ensureDir(configured ? path.resolve(configured) : path.resolve(process.cwd(), "data"));
}

// 2) 系统路径：context-free，供 registry / 全局心跳 / 日志等使用
export function getSystemDataDir() {
  return ensureDir(path.join(getDataBaseDir(), "system"));
}
export function getRegistryDatabaseFilePath() {
  return path.join(getSystemDataDir(), "registry.db");
}

// 3) 用户路径：要求 ALS 上下文（缺失即 throw，暴露漏注入的 bug）
export function getProjectRootDataDir() {
  const userId = getCurrentUserId();           // ← 从 ALS 取，缺失即抛
  return ensureDir(path.join(getDataBaseDir(), "users", userId));
}
```

> - Registry DB 路径走 `getSystemDataDir()`，**不走** `getProjectRootDataDir()`，避免对用户上下文产生依赖（鸡生蛋问题）。
> - `~/.kiki/runtime` 下的 `config.json`/`device.json`/`state.json`/`logs` 由 `getRuntimeHomeDir()` 派生（基于 `os.homedir()`，与用户上下文无关），保持原样即可——这部分本就是"本机 daemon 自身状态"，不属于任何云端账号。
> - **落地纪律**：凡是"系统级/无用户态"的代码路径（startup 自检、心跳写入、registry 增删查）一律调用系统路径函数；只有"业务数据"才允许走 `getProjectRootDataDir()`。

改造 [db/client.ts](../../src/lib/server/db/client.ts)：把当前的单例 `db` 改为 `Map<userId, Database>` 缓存（key 用 `getCurrentUserId()`），inode 自检逻辑按 user 维度保留。**新增连接淘汰策略**：长期累积大量 per-user 句柄会撑爆文件描述符（每个 WAL 库还带 `-wal`/`-shm`），需对该 Map 做 LRU + 空闲超时关闭（如最多保留 N 个、空闲 > M 分钟即 `close()`）。Registry DB 单独一个长驻句柄，不进 user 缓存。

### 4.1 进程内单例与内存态隔离（物理分库管不到的部分）

物理分库只隔离了「磁盘/DB」，**进程内的单例、缓存、定时器、事件总线在同一个 Node 进程里是全局共享的**，必须逐项审计并按 user 维度隔离。落地前需对照下表逐条处理，并写进 P3 验收：

| 内存态 | 现状 | 多租户处理 |
| --- | --- | --- |
| `executionSupervisor` | 进程级单例，`Map<requestId, job>` | 云端编排形态下若仍跑对账，需 key 带 userId 或改为 `Map<userId, Supervisor>`；执行下沉本地后该单例主要在**本地 daemon**侧运行 |
| `threadLoopDaemon` | 启动时 `setInterval` 创建一次 | 改为"每帧遍历用户 → 进上下文执行"，或每用户一个实例并统一调度 |
| dispatch / reconcile 帧 | 各自独立 `setInterval`，裸调 `getDatabase()` | 同上，必须包进 `runWithUserContext`；空转优化见 §6.1 |
| 快照/遥测缓存 | `stateSnapshot` 经核查**每次读 DB、无内存缓存**（安全）；`goalTelemetry` 等需逐个确认是否有进程级 Map | 凡是 module 级 `Map`/对象缓存且未带 userId 的，一律改为带 userId 或下沉到 per-user DB |
| SSE / 实时事件流 | 前端实时更新若走 SSE 或进程内事件总线 | 订阅必须按 session 的 userId 过滤，杜绝跨户推送 |

> 审计方法：全局搜索 module-level `new Map(`/单例 `export const xxx = new ...()`，逐个判断"是否承载跨请求状态"，承载则必须带 userId 或下沉到 per-user DB。

## 5. 认证层设计

### 5.1 Registry schema（新增 `src/lib/server/db/registrySchema.ts`）

```sql
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,           -- 不透明 ID，作为数据目录名
  email         TEXT NOT NULL UNIQUE,       -- 存小写规范化后的邮箱
  password_hash TEXT NOT NULL,              -- scrypt 派生
  password_salt TEXT NOT NULL,
  display_name  TEXT NOT NULL,              -- 注册昵称可选；为空时后端用邮箱前缀兜底填充
  status        TEXT NOT NULL DEFAULT 'active', -- 预留 disabled/deleted，本期仅 active；账号停用/删除工具不在本期
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,             -- 高熵随机串(存哈希)
  user_id     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- 本地执行节点（machine）注册表：承载反向通道身份（详见 local-runtime-cloud-tunnel-plan.md）
CREATE TABLE IF NOT EXISTS machines (
  id            TEXT PRIMARY KEY,           -- machineId
  user_id       TEXT NOT NULL,              -- 归属账号
  api_key_hash  TEXT NOT NULL,              -- sk_machine_* 的哈希，绝不明文存
  name          TEXT,                       -- 用户可读机器名
  fingerprint   TEXT,                       -- 机器码+OS 指纹，二次注册校验防 key 盗用
  last_seen_at  TEXT,                       -- 心跳时间，用于在线判定
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_machines_user ON machines(user_id);
```

> `machines` 表归属账号体系（owner 关系 + api-key 鉴权），其连接生命周期/心跳/路由由反向通道方案（local-runtime-cloud-tunnel-plan.md 的 C-1/C-2）实现。两方案共用此表，避免双写。

### 5.2 密码与会话

- **密码哈希**：Node 内置 `crypto.scrypt`（零外部依赖，符合"起步轻量"）。每用户独立 salt。
- **会话**：登录时生成 32 字节随机 token，**存储其 SHA-256**（库被读也无法直接冒用），明文 token 下发到 httpOnly + Secure + SameSite=Lax cookie。默认 30 天有效，滑动续期。
  - **续期写放大优化**：每请求都 update `last_seen_at` 会让 registry.db 写过频，改为**节流续期**（如距上次写入 > 1h 才更新），降低写压力。
- **登出**：删除 sessions 行 + 清 cookie。

### 5.3 认证 API（`src/app/api/auth/*`）

| 路由 | 方法 | 作用 |
| --- | --- | --- |
| `/api/auth/register` | POST | 校验邮箱唯一 → 建 user → **初始化其数据目录 + per-user DB bootstrap + seed 初始快照** → 建 session |
| `/api/auth/login` | POST | 校验密码 → 建 session |
| `/api/auth/logout` | POST | 销毁 session |
| `/api/auth/me` | GET | 返回当前用户信息（前端用于判断登录态） |

服务层 `src/lib/server/services/authService.ts` 收口全部凭据逻辑（注册、校验、session 增删查）。

> **新用户 seed（必做，否则调度静默哑火）**：新账号的 per-user DB 里 `runtimeEnvironments` 快照为空，会导致 `selectLocalRuntimeEnv()` 返回 `null`、调度无声失败。注册时必须在 `runWithUserContext(newUserId, …)` 内显式：①触发 `getDatabase()` 跑一次 `KIKI_DB_BOOTSTRAP_SQL`/迁移建表；②写入初始快照（`upsertRuntimeEnvironmentsSnapshot(INITIAL_RUNTIME_ENVIRONMENTS)`、空 `goals`/`topics` envelope 等）。建议抽 `src/lib/server/services/userProvisioning.ts` 统一收口"开户即初始化"。`display_name` 为空时用邮箱 `@` 前缀兜底。

### 5.4 路由保护

改造 [middleware.ts](../../src/middleware.ts)（保留现有 legacy goals 重定向）：

- 放行白名单：`/api/auth/*`、`/login`、`/register`、Next 静态资源、`favicon`。
- 其余请求：**只做"有无 session cookie"的轻校验**——无 cookie 时 API 返回 401、页面 302 到 `/login`。**middleware 不解析身份、不查库、不注入任何用户头**。

> middleware 默认 Edge runtime 不能用 `better-sqlite3`，所以**真正的 session 校验放在 Node runtime 的 route handler 层**：
> - **采用 A（确定方案）**：middleware 只做 cookie 有无的跳转；真正校验放每个 route handler 入口的 `withAuth()` 包装器（Node runtime）。
> - ~~B：给 middleware 配 `runtime='nodejs'`~~ —— 不采用，稳定性与冷启动代价不值。

**身份只在 `withAuth()` 内派生（对应 D8）**：新增 `src/lib/server/http/withAuth.ts`，统一完成「读 cookie → 查 sessions 表校验有效 → 取出 userId → `runWithUserContext(userId, handler)`」。所有业务 route handler 用它包一层，上下文注入只有这一个入口。

> **安全红线**：
> - **禁止用请求头（如 `x-user-id`）传递身份**。userId 一律由服务端从已校验 session 现取；并在入口**主动剥离/忽略客户端传入的任何 `x-user-id` 同名头**，否则 `curl -H "x-user-id: <受害者>"` 即可越权。（这是对早期"middleware 注入 x-user-id"设计的纠正。）
> - **CSRF**：cookie 鉴权 + `SameSite=Lax` 不足以完全防 CSRF。对所有改状态的请求（POST/PUT/DELETE）在 `withAuth` 内**校验 `Origin`/`Sec-Fetch-Site` 同源**（或要求自定义请求头），拒绝跨站写。
> - **runtime 保证**：所有用到 `better-sqlite3` 的 route handler 必须运行在 Node runtime（App Router route handler 默认即 Node；建议在约定/模板里显式 `export const runtime = 'nodejs'` 防误配为 edge）。

## 6. 执行编排与并发（云端编排 + 本地执行）

**daemon 双形态（对应 D9）**：`daemonRunner` 的核心调度逻辑是同一份代码，靠启动模式切换两种部署形态——

| 形态 | 部署位置 | 是否 spawn claude | 用途 |
| --- | --- | --- | --- |
| **本地执行形态** | 用户本机（含 P0 本地单用户开发） | 是 | 真正跑任务，落地工作区文件 |
| **云端编排形态** | Railway 单 service | **否** | 列用户 → 选 machine → 经 Tunnel Hub 下发 execute → 消费回传事件、更新投影 |

> 这与 [local-runtime-cloud-tunnel-plan.md](./local-runtime-cloud-tunnel-plan.md) §九"同一份核心、两种部署形态"一致。**不要把 `daemonRunner` 整体改写成只剩云端编排**——P0 及本地用户仍依赖本地执行形态。建议把"是否本地执行"抽成注入的执行后端（local-spawn vs tunnel-dispatch），核心调度帧不变。

执行下沉本地后，云端编排形态不再 spawn claude CLI，[daemonRunner.ts](../../src/lib/daemon/daemonRunner.ts) 的角色变为"**云端编排器**"：决定该把哪个任务下发到哪台 machine，并消费回传的事件流。

### 6.1 调度帧（云端编排器）

```ts
// 伪代码：云端编排帧
for (const user of listUsersWithPendingWork()) {   // 来自 registry DB
  runWithUserContext(user.id, () => {
    runGoalSchedulerEngine(...);                    // 仍在云端：拆解目标、推进状态机
    dispatchReadyTasksToMachines(user.id);          // 新增：选 machine → 经 Tunnel Hub 下发 execute
    reconcileRuntimeJobLeasesAndProjections();      // 消费本地回传事件，更新投影
  });
}
```

要点：

- `listUsersWithPendingWork()` 查 Registry DB（不在任何用户上下文内）；按"有待办任务 + 有在线 machine"过滤，避免空转遍历全量用户。
- 任务派发前检查该 user 是否有**在线 machine**（`machines.last_seen_at` 新鲜）；无在线机器 → 任务进 `pending`，machine 上线后回放（复用反向通道方案的离线队列 C-6）。
- claude CLI **不在云端执行**；`claudeJsonInvoke` 等执行路径迁移/复用到本地 daemon 侧，云端只持有任务镜像与事件投影。
- 每用户的编排状态/心跳/日志按 user 维度隔离（per-user DB 内），天然不互相覆盖。
- **改造范围提醒**：`daemonRunner` 现有的 `threadLoopDaemon`、dispatch 帧、reconcile 帧、心跳写入是**各自独立的 `setInterval`/裸调用**，每一条都得改成"先用系统上下文列用户 → 逐户 `runWithUserContext` 执行"。仅改 §6.1 主帧不够。
- **进程内单例**（`executionSupervisor` 等）按 §4.1 处理：云端编排形态若保留对账，单例需 key 带 userId 或按用户实例化；本地执行形态下单例天然单用户、无需改。

### 6.2 两层并发预算（D2）

```
                 ┌─ N_global：全局总闸（保护 Railway 编排进程 & Tunnel Hub）
并发上限 = min ──┤
                 └─ N_user：单账号上限（防单租户独占下发通道）
```

- 现 `maxConcurrentTasks`（全局值）拆为两个配置：`KIKI_MAX_CONCURRENT_GLOBAL` 与 `KIKI_MAX_CONCURRENT_PER_USER`。
- 派发判定：`当前全局在执行数 < N_global` **且** `该用户在执行数 < N_user` 才下发，否则排队。
- 注意：真正的算力在用户本地，云端这层闸主要保护**编排/通道资源**与防滥用；本地 daemon 侧另有自身并发上限（属反向通道方案）。两层互不替代。

> 规模权衡：用户量大时按"有待办 + 在线"过滤即可显著降本；后续可加 `active_users` 派生表进一步优化。

## 7. Railway 部署（单 service 单 Volume）

**关键约束（已查证）**：Railway **不支持跨 service 共享 Volume**——官方文档明确每个 service 只能挂一个卷（"Each service can only have a single volume"），且为防数据损坏会阻止多个部署同时挂载同一卷；社区答复亦确认无法在两个 service 间共享 volume。因此早期设想的"web 与 worker 两 service 共享 Volume"在 Railway 上不可行。

**结论**：因执行已下沉本地（claude CLI 跑在用户机器、用户自带 key），云端无需重型 worker 进程，**收敛为单 service 单 Volume**，上述限制自然规避。

- **持久化 Volume**：容器文件系统是临时的，必须挂 Volume 到固定路径并设 `KIKI_DATA_DIR` 指向该挂载点（例如 `/data`）。所有 `data/users/*` 与 `data/system` 落在 Volume 上。
- **进程拓扑**：单 service 内同时承载 Next 路由 + 云端编排器（调度帧）+ Tunnel Hub（反向通道接入）；无独立 worker service，规避跨 service 卷共享限制。
- **非 root 卷权限**：镜像以非 root 运行而卷属 root 时，必要时设 `RAILWAY_RUN_UID=0` 以获得写权限。
- **重部署短暂停机**：带卷的 service 重部署时，为防卷损坏会有秒级停机（新旧实例不会同时持有卷），属预期行为。
- **Cookie**：生产强制 `Secure`，`SameSite=Lax`；Railway 提供 HTTPS 域名，满足要求。
- **环境变量**：新增 `KIKI_DATA_DIR`、`SESSION_TTL_DAYS`、`KIKI_AUTH_COOKIE_NAME`、`KIKI_MAX_CONCURRENT_GLOBAL`、`KIKI_MAX_CONCURRENT_PER_USER`、`KIKI_USER_STORAGE_LIMIT_MB`（per-user 存储软上限）、`KIKI_REGISTER_RATE_LIMIT`（注册限速）、`KIKI_DB_CACHE_MAX`/`KIKI_DB_CACHE_IDLE_MS`（per-user 连接缓存 LRU/空闲关闭）、`KIKI_DISABLE_DEV_ROUTES`（生产关闭 `/api/dev/*`）。

## 8. 安全要点

- 密码 scrypt + 每用户 salt；绝不明文/可逆存储。
- session token 存哈希、httpOnly、Secure、SameSite。
- 注册接口邮箱规范化（小写、trim）+ 唯一约束防重复。
- `userId` 作为目录名，必须用不透明随机 ID（复用现有 `opaqueIds`），**禁止**用邮箱等用户可控值拼路径，杜绝路径穿越。
- 登录失败做基础限速（同 IP/邮箱滑动窗口），防暴力破解（可后置到第二阶段）。
- **身份不经请求头传递**，入口剥离客户端 `x-user-id`；改状态请求校验同源（CSRF）。详见 §5.4。

### 8.1 开放注册防滥用（D5 的强制配套，单 Volume 必做）

开放注册 + 单 Volume + 无配额 = **磁盘填满型 DoS**（任意人批量注册、每人一套 DB+storage 写满整卷拖垮全站）。以下为必做项，不做则不能开放注册：

- **注册限速**：同 IP/时间窗滑动限频；建议加人机校验（验证码）阈值。
- **per-user 存储软上限**：对 `data/users/<uid>` 目录用量设上限（如默认 N MB/GB，可经环境变量调），超限拒绝写入并提示。
- **卷用量监控告警**：Volume 总用量接近阈值时告警；规划 Volume 容量上限与账号数上限。
- **僵尸账号回收**：长期未登录且无 machine 的账号可归档/清理（本期可仅记录策略，不实现）。

## 9. 数据迁移（D7：可直接 reset）

现有单库 `data/kiki.db` 为开发期数据，**用户已确认可直接 reset，不保留旧数据**：

- **不实现** legacy 迁移脚本（无 `scripts/migrate-legacy-to-user.ts`），避免一次性脚本的维护成本。
- 切换到多租户目录结构时，直接走 `resetLocalDataForDev`（同步更新它以适配新的 `data/users/*` + `data/system` 目录结构），生成干净的初始状态。
- 后续如需保留生产数据再按需补迁移工具，不在本期范围。

> **生产安全（必做）**：
> - 现有 `src/app/api/dev/runtime/reset-local-data/route.ts` 等 `/api/dev/*` 在多租户生产环境等于"人人可清库"。**生产必须整体关闭 `/api/dev/*`**（按 `NODE_ENV`/开关），或仅放行受信运维。
> - `closeDatabaseForReset()` 现在关的是单例句柄；多租户下 reset 必须 **scope 到当前用户**：只关该 userId 的缓存句柄、只清该用户目录，绝不能误清他人。用户级"重置我的数据"与开发期"清空全部"是两个不同能力，需区分。

## 10. 前端改造

- 新增 `/login`、`/register` 页面与表单。
- `UserMenu` 改为读 `/api/auth/me` 真实数据，登出调用 `/api/auth/logout` 后跳转 `/login`。
- 全局未登录态拦截：根布局或 provider 层根据 `me` 结果重定向。

### 10.1 登录 / 注册交互规格（已定稿）

视觉 Mock：[docs/draft/auth-login-register-mock.html](../draft/auth-login-register-mock.html)。严格遵循设计规范色板与 Geist 字体。

**布局**

- 登录 / 注册页**脱离 AppShell**（无侧边栏），浅灰底 `#F5F6F8` 上居中单卡片（`max-w-400px`，白底圆角 16px，细边框 + 轻阴影）。
- 页面**左上角固定黑色文字 logo「KiKi」**（22px 加粗，`#1F2328`），卡片内不再放品牌头像。
- 登录 / 注册为**同卡片内两视图切换**（非独立跳转），底部链接互切。

**登录视图**

- 标题「账号登录」，副标题「登录以进入你的工作空间」。
- 字段：邮箱、密码（带可见切换）。
- 失焦即时校验（邮箱格式、密码必填）；提交前全量校验。
- 提交 loading：按钮转 spinner + 文案「登录中…」，禁用防重复提交。
- 登录失败：卡片顶部通栏 `bg-#FEF2F2 / text-#B42318`「邮箱或密码不正确」（不暴露是邮箱还是密码错，防枚举）。
- 底部「还没有账号？创建账号」切到注册视图。

**注册视图**

- 标题「创建账号」，副标题「注册即获得一个完全独立的工作空间」。
- 字段：邮箱、密码、确认密码（均带可见切换）、昵称（可选，留空用邮箱前缀）。
- 密码强度条：输入时实时显示 弱 / 中 / 强（红 `#B42318` / 黄 `#8A6D3B` / 绿），仅引导不强制（除最低 8 位且含字母+数字）。
- 失焦即时校验：邮箱格式、密码规则、两次密码一致、昵称 ≤30 字。
- 后端错误回填：邮箱已存在 → 定位到邮箱字段红字「该邮箱已被注册，换一个或直接去登录」。
- 成功即**自动登录**（同响应种 cookie）→ `router.replace('/')` 进首页（不留注册页在历史栈）→ 首页空状态引导。

**通用交互**

- 字段三态：默认 / 失焦校验 / 错误；错误信息具体，输入框转 `border-#FECACA` 并在下方红字提示。
- 回车提交；密码右侧眼睛图标切换明文。
- 无障碍：label 关联 input、错误 `aria-describedby`、按钮 `aria-busy`。

> 本期不含「记住我」「找回密码」入口；预留位但不实现。

## 11. 分阶段实施


> **依赖与排期关键**：P0/P1/P2（上下文 + 认证 + 隔离）**完全自洽、可独立交付**，不依赖反向通道。**P3 的"下发到本地 machine 执行"硬依赖 [local-runtime-cloud-tunnel-plan.md](./local-runtime-cloud-tunnel-plan.md) 的 C-1~C-9**（自评 4-5 周）。用户确认的产品模型即"用户连接本机 CLI、用自己的 key"——因此**注册后未连接 machine 时显示"连接你的本机"是预期 UX，不是坏状态**，无需为过渡态额外造执行路径。建议把 P3 拆成 P3a（per-user 编排骨架，可用固定/本地执行后端验证）与 P3b（接 Tunnel Hub 真下发，随 tunnel plan 落地）。

| 阶段 | 内容 | 依赖 | 验收 |
| --- | --- | --- | --- |
| P0 上下文底座 | `userContext` + `paths.ts` 拆系统/用户双轨 + `db/client.ts` per-user 缓存（含 LRU/空闲关闭）；用固定 `local-user` 跑通（行为不变） | 无 | 现有功能在 `data/users/local-user/` 下正常运行；系统路径（registry/心跳/日志）不依赖用户上下文不报错 |
| P1 认证层 | Registry DB + authService + auth API + `withAuth`（含身份只在此派生、剥离 x-user-id、CSRF 同源校验）+ middleware 轻校验 + 新用户 seed | P0 | 注册/登录/登出全流程通；未登录访问被拦；伪造 `x-user-id` 无效 |
| P2 全路由接入 + 内存态隔离 | 所有业务 route handler 套 `withAuth`；前端登录页与守卫；按 §4.1 完成单例/缓存/SSE 隔离审计 | P1 | 两个账号互不可见对方数据；并发请求/SSE 无串户 |
| P3a 多租户编排骨架 | 云端调度帧逐户推进（`listUsersWithPendingWork`）；`daemonRunner` 各独立循环全部包进用户上下文；两层并发预算（global/per-user） | P2 | 多用户编排状态各自在自己目录推进、互不串扰（执行后端可先用本地/桩验证） |
| P3b 接反向通道下发 | `dispatchReadyTasksToMachines` 经 Tunnel Hub 下发 + 消费回传事件投影 | **tunnel plan C-1~C-9** | 多用户任务经各自在线 machine 在本地执行，产物落各自本地工作区 |
| P4 部署 | Railway 单 service 单 Volume + `KIKI_DATA_DIR`；生产关闭 `/api/dev/*`；开放注册防滥用（§8.1）；reset 旧数据（不做 legacy 迁移） | P2（P3b 视 tunnel 进度） | 云端可注册多账号并持久化，重部署后数据仍在；dev 路由不可达 |

## 12. 验收标准（整体）

- 注册 A、B 两个账号，各自创建 topic/任务，互相完全不可见。
- 文件系统中存在 `data/users/<A>/kiki.db` 与 `data/users/<B>/kiki.db` 两套物理库；registry 在 `data/system/registry.db`。
- **新注册账号开箱可用**：seed 后 `runtimeEnvironments` 非空，调度不哑火。
- **越权/串户防线**：携带他人 `x-user-id` 头无效；并发请求与 SSE 不串户；用户级 reset 只影响自己。
- 云端编排器能同时推进 A、B 的任务、经各自在线 machine 在本地执行，产物分别落在各自本地工作区（P3b，依赖 tunnel）。
- 登出后无法访问任何业务接口（401/跳转登录）。
- Railway 重部署后数据仍在（单 Volume 生效）；生产环境 `/api/dev/*` 不可达。

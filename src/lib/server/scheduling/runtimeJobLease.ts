/**
 * runtimeJobLease — runtime_jobs 续租相关的共享常量与小工具。
 *
 * §candidate-4 P7：local taskDispatchWorker 与 cloud taskDispatcher 各自重复
 * 定义同一组 lease 常量。两条 dispatch 路径的执行模型差异较大（本地同步执行 vs
 * 远程异步派发 + 回执），不强行抽取统一 dispatch loop；但**lease 续租这一段**
 * 是真正同形：同一 repo API + 同一时长。集中到本模块作为单一来源，避免常量
 * 漂移（"local 改 30s cloud 还是 30s" 之类的隐式不一致）。
 *
 * 不做的事（已审视后决定不做）：
 *  - 不抽 lease renew 的完整 setInterval 循环——本地走 ProcessSupervisor
 *    生命周期，远端走 machine online/offline 检测，循环体差异大于共性。
 *  - 不抽 dispatch loop 的统一 transport adapter——两条路径的执行模型本质不同：
 *    local 是同步直执行（runGoalTask → await），cloud 是异步远程派发（hub.sendExecute
 *    + 回执监听）；并发预算来源也不同（local config.maxConcurrentTasks vs
 *    orchestratorConcurrencyBudget）；ProcessSupervisor / TunnelHub /
 *    ToolPermissionBroker 的 lifecycle 不可互换。强行融合会把不同执行模型挤进
 *    同一抽象，反而增加耦合。这两条路径是 "two surfaces, one inspiration"，不是
 *    "two adapters of one interface"。
 */

/** dispatch 帧内 lease 续租的轮询间隔（ms）。 */
export const RUNTIME_JOB_LEASE_RENEW_INTERVAL_MS = 30 * 1000;

/** 单次 lease 续租后的有效期（ms）。 */
export const RUNTIME_JOB_LEASE_RENEW_DURATION_MS = 2 * 60 * 1000;

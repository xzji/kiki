import { appendRuntimeDaemonLog } from "@/lib/daemon/daemonState";
import { isRuntimeJobLeaseHeld } from "@/lib/server/repositories/runtimeJobsRepository";

/**
 * ExecutionSupervisor —— worker 进程内的「执行生命周期所有者」。
 *
 * 背景（见方案）：此前「谁启动子进程、谁负责回收、谁对账 DB」分散在 worker 各处，
 * 导致挂死的 Claude CLI 子进程既无法被超时回收，也无法在 job 行被删后被终止，
 * 形成隐身的僵死进程并阻塞调度。
 *
 * 本类把单个 job 的执行生命周期（AbortController、OS 进程 pid、进展时间、超时计时器）
 * 绑定到同一个所有者，对外暴露统一的 register / attachProcess / markProgress /
 * abort / complete 接口，并提供 reconcileJobOwnership() 做周期性对账：
 *   - 空闲超时（idleTimeoutMs 内无任何进展事件）；
 *   - 总时长超时（maxDurationMs，由独立计时器精确触发）；
 *   - DB 所有权丢失（job 已被删除 / 状态非 running / lease 被夺）。
 * 命中任一条件即统一调用 abort，由 transport 的 abort 监听强杀进程组。
 *
 * 注意：仅保存进程内临时状态，不做持久化；runtime_jobs 仍是权威业务状态。
 */
export type SupervisedJobInput = {
  requestId: string;
  jobId: string;
  leaseOwner: string;
  abortController: AbortController;
  maxDurationMs: number;
  idleTimeoutMs: number;
};

type SupervisedJob = {
  requestId: string;
  jobId: string;
  leaseOwner: string;
  abortController: AbortController;
  maxDurationMs: number;
  idleTimeoutMs: number;
  startedAt: number;
  lastProgressAt: number;
  pid?: number;
  aborted: boolean;
  durationTimer: NodeJS.Timeout;
};

export class ExecutionSupervisor {
  private readonly jobs = new Map<string, SupervisedJob>();

  /** 登记一个开始执行的 job。以 requestId 为 key（RunGoalTaskInput 仅持有 requestId）。 */
  registerJob(input: SupervisedJobInput) {
    // 防御：同一 requestId 重复登记时，先清理旧记录。
    this.disposeJob(input.requestId);
    const now = Date.now();
    const durationTimer = setTimeout(() => {
      this.abortJob(input.requestId, `执行超时：超过总时长上限 ${input.maxDurationMs}ms`);
    }, input.maxDurationMs);
    durationTimer.unref?.();
    this.jobs.set(input.requestId, {
      requestId: input.requestId,
      jobId: input.jobId,
      leaseOwner: input.leaseOwner,
      abortController: input.abortController,
      maxDurationMs: input.maxDurationMs,
      idleTimeoutMs: input.idleTimeoutMs,
      startedAt: now,
      lastProgressAt: now,
      aborted: false,
      durationTimer,
    });
  }

  /** Claude CLI spawn 成功后绑定 OS 进程 pid（用于日志与对账观测）。 */
  attachProcess(requestId: string, pid: number) {
    const job = this.jobs.get(requestId);
    if (!job) return;
    job.pid = pid;
  }

  /** 收到流式进展事件（delta/tool_call/status/message）时刷新活跃时间，重置空闲判定。 */
  markProgress(requestId: string, _kind: string) {
    const job = this.jobs.get(requestId);
    if (!job) return;
    job.lastProgressAt = Date.now();
  }

  /** 统一触发 abort（防重入）。实际进程终止由 transport 的 abort 监听 → killChildTree 完成。 */
  abortJob(requestId: string, reason: string) {
    const job = this.jobs.get(requestId);
    if (!job || job.aborted) return;
    job.aborted = true;
    appendRuntimeDaemonLog(
      `任务 ${job.jobId} 被 ExecutionSupervisor 中止${job.pid ? `（pid=${job.pid}）` : ""}：${reason}`,
    );
    try {
      job.abortController.abort();
    } catch {
      // AbortController 已 abort 或异常，忽略。
    }
  }

  /** 任务结束销账（成功或失败统一走此路径，清理内存态与总时长计时器）。 */
  completeJob(requestId: string) {
    this.disposeJob(requestId);
  }

  /**
   * 周期性对账（由 daemonRunner 的独立节拍调用）：
   * 对每个在管 job 检查空闲超时与 DB 所有权，命中即统一 abort。
   * 总时长超时由 registerJob 的独立计时器精确触发，这里只兜底再判一次。
   */
  reconcileJobOwnership() {
    const now = Date.now();
    for (const job of Array.from(this.jobs.values())) {
      if (job.aborted) continue;
      if (now - job.lastProgressAt > job.idleTimeoutMs) {
        this.abortJob(
          job.requestId,
          `执行超时：${job.idleTimeoutMs}ms 内无任何进展事件（疑似卡死）`,
        );
        continue;
      }
      if (now - job.startedAt > job.maxDurationMs) {
        this.abortJob(job.requestId, `执行超时：超过总时长上限 ${job.maxDurationMs}ms`);
        continue;
      }
      // DB 所有权对账：job 行被删 / 状态非 running / lease 被夺 → 终止本地进程。
      if (!isRuntimeJobLeaseHeld(job.jobId, job.leaseOwner)) {
        this.abortJob(
          job.requestId,
          "检测到 job 已被删除或 lease 已失效，正在终止子进程",
        );
      }
    }
  }

  /** 仅供测试/观测：当前在管 job 数量。 */
  size() {
    return this.jobs.size;
  }

  private disposeJob(requestId: string) {
    const job = this.jobs.get(requestId);
    if (!job) return;
    clearTimeout(job.durationTimer);
    this.jobs.delete(requestId);
  }
}

/** worker 进程内单例。 */
export const executionSupervisor = new ExecutionSupervisor();

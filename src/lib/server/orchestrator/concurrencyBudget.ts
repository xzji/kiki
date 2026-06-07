import type { OrchestratorConfig } from "@/lib/server/orchestrator/orchestratorConfig";

/** 进程内全局 + 单用户并发预算（P3 两层闸）。 */
class ConcurrencyBudget {
  private globalInFlight = 0;
  private readonly perUserInFlight = new Map<string, number>();

  getGlobalInFlight() {
    return this.globalInFlight;
  }

  getUserInFlight(userId: string) {
    return this.perUserInFlight.get(userId) ?? 0;
  }

  availableSlots(userId: string, config: Pick<OrchestratorConfig, "maxConcurrentGlobal" | "maxConcurrentPerUser">) {
    const userInFlight = this.getUserInFlight(userId);
    const perUserRemaining = config.maxConcurrentPerUser - userInFlight;
    const globalRemaining = config.maxConcurrentGlobal - this.globalInFlight;
    return Math.max(0, Math.min(perUserRemaining, globalRemaining));
  }

  acquire(userId: string, count: number) {
    if (count <= 0) return;
    this.globalInFlight += count;
    this.perUserInFlight.set(userId, this.getUserInFlight(userId) + count);
  }

  release(userId: string, count: number) {
    if (count <= 0) return;
    this.globalInFlight = Math.max(0, this.globalInFlight - count);
    const next = Math.max(0, this.getUserInFlight(userId) - count);
    if (next === 0) {
      this.perUserInFlight.delete(userId);
    } else {
      this.perUserInFlight.set(userId, next);
    }
  }
}

export const orchestratorConcurrencyBudget = new ConcurrencyBudget();

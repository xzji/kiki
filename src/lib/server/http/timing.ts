type TimingCounts = Record<string, number | undefined>;

function nowMs() {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

export function estimateJsonBytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function createApiTimer(route: string) {
  const startedAt = nowMs();
  const phases: Record<string, number> = {};

  return {
    async measure<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
      const phaseStartedAt = nowMs();
      try {
        return await fn();
      } finally {
        phases[name] = Math.round(nowMs() - phaseStartedAt);
      }
    },
    finish(input: { counts?: TimingCounts; responseBytes?: number } = {}) {
      const counts = Object.fromEntries(
        Object.entries(input.counts ?? {}).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
      );
      console.info(
        JSON.stringify({
          scope: "api_timing",
          route,
          duration_ms: Math.round(nowMs() - startedAt),
          response_bytes: input.responseBytes,
          counts,
          phases,
        }),
      );
    },
  };
}

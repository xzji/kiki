type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

function readLimitPerHour() {
  const parsed = Number(process.env.KIKI_REGISTER_RATE_LIMIT_PER_HOUR ?? "10");
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 10;
}

export function checkRegisterRateLimit(clientKey: string): { ok: true } | { ok: false; reason: string } {
  const limit = readLimitPerHour();
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const bucket = buckets.get(clientKey);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(clientKey, { count: 1, resetAt: now + windowMs });
    return { ok: true };
  }
  if (bucket.count >= limit) {
    return { ok: false, reason: "注册过于频繁，请稍后再试" };
  }
  bucket.count += 1;
  return { ok: true };
}

export function resolveRegisterClientKey(request: { headers: { get(name: string): string | null } }) {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() || "unknown";
  }
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

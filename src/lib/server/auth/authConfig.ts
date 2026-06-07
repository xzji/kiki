export const SESSION_COOKIE_NAME = process.env.KIKI_AUTH_COOKIE_NAME?.trim() || "kiki_session";
export const SESSION_TTL_DAYS = Number(process.env.SESSION_TTL_DAYS ?? "30");
export const SESSION_RENEW_INTERVAL_MS = 60 * 60 * 1000;

export function isDevRoutesDisabled() {
  if (process.env.KIKI_DISABLE_DEV_ROUTES === "true") return true;
  return process.env.NODE_ENV === "production";
}

import { AsyncLocalStorage } from "node:async_hooks";

/** P0 本地 daemon / 脚本在无 HTTP 会话时使用的默认用户 ID */
export const DEFAULT_LOCAL_USER_ID = process.env.KIKI_DEFAULT_USER_ID?.trim() || "local-user";

type UserContext = { userId: string };

const als = new AsyncLocalStorage<UserContext>();

export function runWithUserContext<T>(userId: string, fn: () => T): T {
  return als.run({ userId }, fn);
}

/** 仅供测试/脚本进程：为后续同步/异步调用设置默认用户上下文（HTTP 请求仍由 withAuth 的 als.run 覆盖）。 */
export function enterUserContext(userId: string) {
  als.enterWith({ userId });
}

export function getCurrentUserId(): string {
  const ctx = als.getStore();
  if (!ctx) {
    throw new Error("缺少用户上下文：未在 runWithUserContext 内调用");
  }
  return ctx.userId;
}

export function hasUserContext(): boolean {
  return Boolean(als.getStore());
}

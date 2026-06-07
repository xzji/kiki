import { runWithUserContext } from "@/lib/server/context/userContext";

/** SSE / 定时器回调在 ALS 外执行时，用请求时的 userId 重新注入上下文。 */
export function bindUserContextTick(userId: string, tick: () => void) {
  return () => {
    runWithUserContext(userId, tick);
  };
}

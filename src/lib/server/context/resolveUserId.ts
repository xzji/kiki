import { DEFAULT_LOCAL_USER_ID, getCurrentUserId, hasUserContext } from "@/lib/server/context/userContext";

export function resolveCurrentUserId() {
  return hasUserContext() ? getCurrentUserId() : DEFAULT_LOCAL_USER_ID;
}

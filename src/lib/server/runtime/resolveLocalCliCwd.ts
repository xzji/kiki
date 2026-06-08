import os from "os";
import path from "path";

import { ensureConversationWorkspace } from "@/lib/server/workspace/conversationWorkspace";
/** 云端传入的 cwd 往往是服务端路径；在 machine 上解析为可写的本地目录。 */
export function resolveLocalCliCwd(input: {
  cwd: string;
  fallbackWorkingDirectory?: string;
  conversationId?: string;
}) {
  if (input.conversationId) {
    return ensureConversationWorkspace(input.conversationId).workspaceDir;
  }
  const home = os.homedir();
  const resolved = path.resolve(input.cwd);
  if (resolved === home || resolved.startsWith(`${home}${path.sep}`)) {
    return resolved;
  }
  return path.resolve(input.fallbackWorkingDirectory || home);
}

import { randomUUID } from "crypto";

import { getDatabase } from "@/lib/server/db/client";
import { INITIAL_RUNTIME_ENVIRONMENTS } from "@/lib/runtime/defaultRuntimeEnvironments";
import { runWithUserContext } from "@/lib/server/context/userContext";
import { writeGoalsProjection } from "@/lib/server/services/goalRuntimeService";
import { upsertRuntimeEnvironmentsSnapshot, upsertTopicsSnapshot } from "@/lib/server/runtime/stateSnapshot";
import { ensureDir } from "@/lib/server/storage/ensureDir";
import { getConversationWorkspacesRootDir, getProjectRootDataDir, getStorageRootDir } from "@/lib/server/storage/paths";

export function provisionUserWorkspace(userId: string) {
  return runWithUserContext(userId, () => {
    const dataDir = getProjectRootDataDir();
    ensureDir(dataDir);
    ensureDir(getStorageRootDir());
    ensureDir(getConversationWorkspacesRootDir());

    getDatabase();
    upsertRuntimeEnvironmentsSnapshot(INITIAL_RUNTIME_ENVIRONMENTS);
    writeGoalsProjection([]);
    upsertTopicsSnapshot([]);
  });
}

export function createOpaqueUserId() {
  return `usr-${randomUUID().replace(/-/g, "")}`;
}

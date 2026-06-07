import { NextResponse } from "next/server";

import {
  getConversationWorkspacesRootDir,
  getDatabaseFilePath,
  getProjectRootDataDir,
  getStorageRootDir,
  getTelemetryFilePath,
} from "@/lib/server/storage/paths";
import { withAuth } from "@/lib/server/http/withAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function GETHandler() {
  return NextResponse.json({
    ok: true,
    paths: {
      dataDir: getProjectRootDataDir(),
      databaseFile: getDatabaseFilePath(),
      storageRoot: getStorageRootDir(),
      conversationWorkspacesRoot: getConversationWorkspacesRootDir(),
      telemetryFile: getTelemetryFilePath(),
    },
    env: {
      KIKI_DATA_DIR: process.env.KIKI_DATA_DIR ?? null,
    },
  });
}

export const GET = withAuth(GETHandler);

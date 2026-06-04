import { NextResponse } from "next/server";

import {
  getConversationWorkspacesRootDir,
  getDatabaseFilePath,
  getProjectRootDataDir,
  getStorageRootDir,
  getTelemetryFilePath,
} from "@/lib/server/storage/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
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

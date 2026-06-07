import { NextResponse } from "next/server";

import { discoverLocalRuntimes } from "@/lib/server/runtimeEnvValidation";
import { withAuth } from "@/lib/server/http/withAuth";

export const runtime = "nodejs";

async function GETHandler() {
  const result = await discoverLocalRuntimes();
  const payload = {
    ...result,
    workingDirectory: process.cwd(),
  };
  return NextResponse.json(payload);
}

export const GET = withAuth(GETHandler);

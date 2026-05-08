import { NextResponse } from "next/server";

import { discoverLocalRuntimes } from "@/lib/server/runtimeEnvValidation";

export const runtime = "nodejs";

export async function GET() {
  const result = await discoverLocalRuntimes();
  const payload = {
    ...result,
    workingDirectory: process.cwd(),
  };
  return NextResponse.json(payload);
}

import { NextResponse } from "next/server";

import { readConversationState } from "@/lib/server/services/conversationCommandService";
import { withAuth } from "@/lib/server/http/withAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function GETHandler() {
  return NextResponse.json({ ok: true, ...readConversationState() });
}

export const GET = withAuth(GETHandler);

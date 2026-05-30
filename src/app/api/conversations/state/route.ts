import { NextResponse } from "next/server";

import { readConversationState } from "@/lib/server/services/conversationCommandService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ ok: true, ...readConversationState() });
}

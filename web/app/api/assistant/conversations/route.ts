import { NextResponse } from "next/server";
import { guardPermission } from "../../../../lib/authz";
import { listConversations } from "../../../../lib/ai-conversations";

export const runtime = "nodejs";

const SCOPE = "assistant";

/** The current user's recent assistant conversations, newest first. */
export async function GET() {
  const gate = await guardPermission("assistant.use");
  if (gate instanceof NextResponse) return gate;
  const items = await listConversations(gate, SCOPE);
  return NextResponse.json({ items });
}

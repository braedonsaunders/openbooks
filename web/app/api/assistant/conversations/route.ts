import { NextResponse } from "next/server";
import { defineRoute } from "../../../../lib/api/route";
import { listConversations } from "../../../../lib/ai-conversations";

export const runtime = "nodejs";

const SCOPE = "assistant";

/** The current user's complete assistant history, newest first. */
export const GET = defineRoute({
  permission: "assistant.use",
  feature: { none: "Assistant access is controlled by assistant permissions and provider configuration." },
  handler: async ({ authz }) => {
  const items = await listConversations(authz, SCOPE);
  return NextResponse.json({ items });
  },
});

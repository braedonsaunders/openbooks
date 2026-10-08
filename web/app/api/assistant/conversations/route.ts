import { NextResponse } from "next/server";
import { defineRoute } from "../../../../lib/api/route";
import { listConversations } from "../../../../lib/ai-conversations";
import { conversationScope } from "../../../../lib/assistant/conversation-scopes";

export const runtime = "nodejs";

/** The current user's complete history in one scope (`?scope=`), newest first. */
export const GET = defineRoute({
  permission: "assistant.use",
  feature: { none: "Assistant access is controlled by assistant permissions and provider configuration." },
  handler: async ({ request, authz }) => {
  const items = await listConversations(authz, conversationScope(new URL(request.url).searchParams.get("scope")));
  return NextResponse.json({ items });
  },
});

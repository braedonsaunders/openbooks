import { defineRoute } from "../../../../../lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  deleteConversation,
  olderMessages,
  ownsConversation,
  recentMessages,
  renameConversation,
} from "../../../../../lib/ai-conversations";
import { abortActiveRun } from "../../../../../lib/assistant/owned-runs";
import { createDbOwnedRunStore } from "../../../../../lib/assistant/owned-runs-db";
import { markTitleRenamed } from "../../../../../lib/assistant/conversation-title";
import { notFound } from "@/lib/api/responses";
import { isUuid } from "@openbooks/engine/src/platform/uuid.ts";
import { conversationScope } from "../../../../../lib/assistant/conversation-scopes";

/** The conversation's scope from `?scope=`; the general assistant when absent. */
const scopeOf = (req: Request) => conversationScope(new URL(req.url).searchParams.get("scope"));

export const runtime = "nodejs";

const renameBody = z.object({ title: z.string().trim().min(1) }).strict();

/**
 * Recent messages of one owned conversation, oldest first. With
 * `?before=<messageId>&limit=<n>` returns the older page above the cursor
 * plus whether more history exists above that page.
 */
export const GET = defineRoute({
  permission: "assistant.use",
  feature: { none: "Assistant access is controlled by assistant permissions and provider configuration." },
  params: z.object({ id: z.string().uuid() }),
  handler: async ({ request: req, authz: gate, params }) => {
  const { id } = params;
  if (!(await ownsConversation(gate, id, scopeOf(req)))) {
    return notFound("record");
  }
  const { searchParams } = new URL(req.url);
  const before = searchParams.get("before");
  if (before !== null) {
    if (!isUuid(before)) return NextResponse.json({ error: "bad request" }, { status: 400 });
    const limit = Number.parseInt(searchParams.get("limit") ?? "", 10);
    const page = await olderMessages(gate, id, before, Number.isFinite(limit) ? limit : undefined);
    return NextResponse.json(page);
  }
  const messages = await recentMessages(gate, id);
  return NextResponse.json({ messages });
  },
});

/** Rename an owned conversation: { title }. */
export const PATCH = defineRoute({
  permission: "assistant.use",
  feature: { none: "Assistant access is controlled by assistant permissions and provider configuration." },
  params: z.object({ id: z.string().uuid() }),
  body: renameBody,
  handler: async ({ request, authz: gate, params, body }) => {
  const { id } = params;
  const renamed = await renameConversation(gate, id, scopeOf(request), body.title);
  if (!renamed) return notFound("record");
  // A user rename wins forever: record the source so a later turn never
  // overwrites it with a generated title. Best-effort, never throws.
  await markTitleRenamed(gate, id);
  return NextResponse.json({ ok: true });
  },
});

export const DELETE = defineRoute({
  permission: "assistant.use",
  feature: { none: "Assistant access is controlled by assistant permissions and provider configuration." },
  params: z.object({ id: z.string().uuid() }),
  handler: async ({ request, authz: gate, params }) => {
  const { id } = params;
  const scope = scopeOf(request);
  // Stop its live run first so it cannot write past the cascade; other
  // conversations' runs are untouched (different rows, different runs).
  await abortActiveRun(createDbOwnedRunStore(gate), id);
  const deleted = await deleteConversation(gate, id, scope);
  if (!deleted) return notFound("record");
  return NextResponse.json({ ok: true });
  },
});

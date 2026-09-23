import { NextResponse } from "next/server";
import {
  actOnInboxItem,
  InboxError,
} from "@openbooks/engine/src/inbox/index.ts";
import { getAuthz } from "../../../../lib/authz";
import { inboxContext } from "../../../../lib/inbox-context";
import { parseJsonBody } from "@/lib/api/json";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const actBody = z.object({
  itemId: z.string().min(1).max(300),
  actionKey: z.string().min(1).max(80),
  reason: z.string().max(2000).optional(),
});

function errorOf(error: unknown): { status: number; message: string } {
  if (error instanceof InboxError) {
    if (error.code === "NOT_FOUND") return { status: 404, message: error.message };
    return { status: 422, message: error.message };
  }
  if (error instanceof z.ZodError) return { status: 400, message: "itemId and actionKey are required" };
  const message = error instanceof Error ? error.message : "the action was refused";
  return { status: 422, message };
}

/**
 * POST /api/inbox/act { itemId, actionKey, reason? } — complete one inbox
 * action through the source's native service. Unknown or invisible items
 * are 404 (never 403 — existence must not leak); refusals carry the
 * service's message intact so the toast can show it.
 *
 * The context carries the session's union scope (roles, subsidiary
 * boundary) — the same scope the inbox list renders — so deciding by id
 * cannot approve an out-of-scope gate a restricted actor guessed or kept.
 */
export async function POST(req: Request) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  const parsedBody = await parseJsonBody(req, actBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    await actOnInboxItem(
      await inboxContext(authz),
      body.itemId,
      body.actionKey,
      body.reason,
    );
    return NextResponse.json({ ok: true });
  } catch (error) {
    const { status, message } = errorOf(error);
    return NextResponse.json({ error: message }, { status });
  }
}

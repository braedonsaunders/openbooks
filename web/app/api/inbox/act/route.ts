import { NextResponse } from "next/server";
import {
  actOnInboxItem,
  InboxError,
  type InboxKind,
} from "@openbooks/engine/src/inbox/index.ts";
import { getAuthz } from "../../../../lib/authz";
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
 */
export async function POST(req: Request) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  const parsedBody = await parseJsonBody(req, actBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    await actOnInboxItem(
      { orgId: authz.user.orgId, actorId: authz.user.id, asOf: new Date().toISOString() },
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

export const INBOX_FILTER_KINDS: Record<string, InboxKind[]> = {
  approvals: ["flows_approval", "expense_report"],
  my_tasks: [
    "hrm_process_step",
    "hrm_leave_request",
    "hrm_change_request",
    "hrm_review",
    "hrm_benefit_enrollment_window",
    "hrm_qualification_alert",
    "timesheet_week",
  ],
  signatures: ["field_ticket_signature", "document_signature"],
  notices: ["notification"],
};

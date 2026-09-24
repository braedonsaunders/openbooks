import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { z } from "zod";
import { canonicalDecimal } from "@/lib/exact-decimal";
import {
  approveLine,
  proposeLine,
  rejectLine,
  reopenLine,
} from "@openbooks/engine/src/hrm/compensation/cycles.ts";
import { guardPermission } from "../../../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../../../lib/features";
import { isUuid } from "../../../../../../../lib/list-params";
import { compensationErrorResponse } from "../../../../compensation/_lib";

export const runtime = "nodejs";

/**
 * The proposal body. The percent and the rate are the two ways a
 * proposal may be expressed; the reason is what carries an
 * outside-guideline proposal, a reopen or a rejection. Each refusal is
 * the one the reviewer reads, so it is declared here rather than left
 * to a generic "expected number".
 */
const PCT_MESSAGE = "proposedPct must be a non-negative percent";
const RATE_MESSAGE = "proposedRate must be a positive amount with at most 4 decimals";

function exactProposedPct(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  // A JSON number is already binary at this boundary. Keep fractional
  // number compatibility only while its representation can retain six
  // decimal places; larger fractional values must arrive as decimal text.
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  const exact = canonicalDecimal(value, 6);
  if (exact === null || exact.startsWith("-")) return null;
  if (typeof value === "number") {
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) return null;
    if (!Number.isInteger(value) && exact.split(".")[0]!.length > 9) return null;
  }
  return exact;
}

const cycleLineBody = z.object({
  // F3-33: the client sends the canonical decimal string the exact
  // parser produced. JSON-number compatibility is normalized directly
  // through the canonical parser and returned as text. One refine keeps
  // the single named refusal (a union reports a bare invalid_union).
  proposedPct: z
    .unknown()
    .refine((v) => v === null || v === undefined || exactProposedPct(v) !== null, PCT_MESSAGE)
    .transform((v) => (v == null ? v : exactProposedPct(v)!))
    .nullish(),
  proposedRate: z
    .string({ error: RATE_MESSAGE })
    .regex(/^\d+(\.\d{1,4})?$/, RATE_MESSAGE)
    .nullish(),
  reason: z.string().nullish(),
});

/**
 * One cycle line: PATCH?action= proposes (the manager's own reports or
 * comp.manage, within guideline or with a reason), reopens a decided
 * line with a reason, or approves/rejects through the Flows gate key
 * with the decider distinct from the proposer. Pushed lines never
 * reopen. The action rides the query string; the body carries the
 * proposal or reason. The client checks res.ok before parsing.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; lineId: string }> }) {
  const { id, lineId } = await params;
  if (!isUuid(id) || !isUuid(lineId)) return NextResponse.json({ error: "invalid cycle line" }, { status: 400 });
  const action = new URL(req.url).searchParams.get("action");
  const parsedBody = await parseJsonBody(req, cycleLineBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  if (action === "propose") {
    // Proposing is the manager's structural scope (or comp.manage in the
    // service) — the route needs only the read grant; the service fences.
    const gate = await guardPermission("hrm.compensation.read");
    if (gate instanceof NextResponse) return gate;
    if (!(await isFeatureEnabled(gate.user.orgId, "hrmMeritCycles"))) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    const proposedPct = body.proposedPct ?? null;
    const proposedRate = body.proposedRate ?? null;
    try {
      const line = await proposeLine({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        lineId,
        proposedPct,
        proposedRate,
        reason: body.reason ?? null,
      });
      return NextResponse.json({ line });
    } catch (e) {
      return compensationErrorResponse(e);
    }
  }
  const gate = await guardPermission("hrm.compensation.approve");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmMeritCycles"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const reason = body.reason?.trim() ? body.reason : null;
  try {
    const q = { orgId: gate.user.orgId, actorId: gate.user.id, lineId };
    if (action === "approve") {
      const line = await approveLine({ ...q, reason });
      return NextResponse.json({ line });
    }
    if (action === "reject" || action === "reopen") {
      if (!reason) return NextResponse.json({ error: "reason required" }, { status: 400 });
      const line = action === "reject" ? await rejectLine({ ...q, reason }) : await reopenLine({ ...q, reason });
      return NextResponse.json({ line });
    }
    return NextResponse.json({ error: "unknown action (propose, approve, reject, reopen)" }, { status: 400 });
  } catch (e) {
    return compensationErrorResponse(e);
  }
}

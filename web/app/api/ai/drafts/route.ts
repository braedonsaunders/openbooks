import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { z } from "zod";
import { draftWithEvidence, DRAFT_KINDS } from "@openbooks/engine/src/hrm/ai/drafting.ts";
import { markDecisionOutcome } from "@openbooks/engine/src/hrm/ai/governance.ts";
import { aiRailsErrorResponse, requireAnyPerm } from "../../../../lib/ai-rails";
import { isFeatureEnabled } from "../../../../lib/features";

export const runtime = "nodejs";

const draftBody = z.object({
  kind: z.enum(DRAFT_KINDS),
  subjectId: z.string().uuid(),
});

const outcomeBody = z.object({
  decisionId: z.string().uuid(),
  outcome: z.enum(["accepted", "edited", "rejected"]),
  note: z.string().max(500).optional(),
});

/**
 * Evidence-grounded drafts. POST renders the outline from sources the
 * actor may read (unreadable sources refuse the whole draft) with bias
 * flags; PATCH records what the human did with it (accepted, edited,
 * rejected) as a new ledger row — the log is append-only, so outcomes
 * are events, never edits. Nothing here files, submits, or stores the
 * draft text anywhere except the UI field the human fills.
 */
export async function POST(req: Request) {
  const gate = await requireAnyPerm([
    "hrm.self.read",
    "hrm.performance.manage",
    "hrm.recruiting.read",
    "hrm.recruiting.manage",
    "hrm.process.read",
  ]);
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmDrafting"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, draftBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const draft = await draftWithEvidence({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      kind: body.kind,
      subjectId: body.subjectId,
    });
    return NextResponse.json({ draft });
  } catch (e) {
    return aiRailsErrorResponse(e);
  }
}

export async function PATCH(req: Request) {
  const gate = await requireAnyPerm([
    "hrm.self.read",
    "hrm.performance.manage",
    "hrm.recruiting.read",
    "hrm.recruiting.manage",
    "hrm.process.read",
  ]);
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmDrafting"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, outcomeBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const decisionId = await markDecisionOutcome({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      decisionId: body.decisionId,
      outcome: body.outcome,
      note: body.note,
    });
    return NextResponse.json({ decisionId });
  } catch (e) {
    return aiRailsErrorResponse(e);
  }
}

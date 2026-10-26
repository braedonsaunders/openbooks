import { NextResponse } from "next/server";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { defineRoute } from "@/lib/api/route";
import { can, getAuthz, type Authz } from "@/lib/authz";
import { draftWithEvidence, DRAFT_KINDS } from "@openbooks/engine/hrm/ai/drafting";
import { markDecisionOutcome } from "@openbooks/engine/hrm/ai/governance";
import { aiRailsErrorResponse } from "@/lib/ai-rails";

export const runtime = "nodejs";

const draftBody = z.object({
  kind: z.enum(DRAFT_KINDS),
  subjectId: uuidString(),
});

const outcomeBody = z.object({
  decisionId: uuidString(),
  outcome: z.enum(["accepted", "edited", "rejected"]),
  note: z.string().max(500).optional(),
});

const DRAFT_PERMISSIONS = [
  "hrm.self.read",
  "hrm.performance.manage",
  "hrm.recruiting.read",
  "hrm.recruiting.manage",
  "hrm.process.read",
] as const;

function missingDraftPermission(authz: Authz): NextResponse | null {
  return DRAFT_PERMISSIONS.some((permission) => can(authz, permission))
    ? null
    : NextResponse.json(
        { error: `missing permission: one of ${DRAFT_PERMISSIONS.join(", ")}` },
        { status: 403 },
      );
}

async function authorizeDrafts(requireAssistantUse: boolean): Promise<Authz | NextResponse> {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const denied = missingDraftPermission(authz);
  if (denied) return denied;
  if (requireAssistantUse && !can(authz, "assistant.use")) {
    return NextResponse.json({ error: "missing permission: assistant.use" }, { status: 403 });
  }
  return authz;
}

/**
 * Evidence-grounded drafts. POST renders the outline from sources the
 * actor may read (unreadable sources refuse the whole draft) with bias
 * flags; PATCH records what the human did with it (accepted, edited,
 * rejected) as a new ledger row — the log is append-only, so outcomes
 * are events, never edits. Nothing here files, submits, or stores the
 * draft text anywhere except the UI field the human fills.
 *
 * Drafts are assembled from HRM records, so both verbs ride Human
 * resources. Producing a draft is an AI surface and also needs the
 * assistant grant; recording what a person did with a draft already shown
 * does not, so the ledger never loses an outcome.
 */
export const POST = defineRoute({
  authorize: () => authorizeDrafts(true),
  feature: "hrm",
  body: draftBody,
  handler: async ({ authz: gate, body }) => {
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
  },
});

export const PATCH = defineRoute({
  authorize: () => authorizeDrafts(false),
  feature: "hrm",
  body: outcomeBody,
  handler: async ({ authz: gate, body }) => {
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
  },
});

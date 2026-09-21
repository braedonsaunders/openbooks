import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import {
  addPoolMember,
  listPoolMembers,
  removePoolMember,
  tagCandidate,
} from "@openbooks/engine/src/hrm/recruiting/pools.ts";
import { guardPermission } from "../../../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../../../lib/features";
import { recruitingErrorResponse } from "../../../_lib";
import { addPoolMemberBody, removePoolMemberBody, tagCandidateBody } from "../../bodies";
import { z } from "zod";

export const runtime = "nodejs";

const memberActionBody = z.union([removePoolMemberBody, tagCandidateBody, addPoolMemberBody]);

/**
 * Pool members: GET lists, POST adds / removes / tags (manage gates in the
 * service). 404s while hrm, hrmRecruiting, or hrmTalentPool is off.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.recruiting.read");
  if (gate instanceof NextResponse) return gate;
  if (
    !(await isFeatureEnabled(gate.user.orgId, "hrm")) ||
    !(await isFeatureEnabled(gate.user.orgId, "hrmRecruiting")) ||
    !(await isFeatureEnabled(gate.user.orgId, "hrmTalentPool"))
  ) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await params;
  try {
    const members = await listPoolMembers({ orgId: gate.user.orgId, actorId: gate.user.id, poolId: id });
    return NextResponse.json({ members });
  } catch (e) {
    return recruitingErrorResponse(e);
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.recruiting.manage");
  if (gate instanceof NextResponse) return gate;
  if (
    !(await isFeatureEnabled(gate.user.orgId, "hrm")) ||
    !(await isFeatureEnabled(gate.user.orgId, "hrmRecruiting")) ||
    !(await isFeatureEnabled(gate.user.orgId, "hrmTalentPool"))
  ) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await params;
  const parsedBody = await parseJsonBody(req, memberActionBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    if ("action" in body && body.action === "remove") {
      await removePoolMember({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        poolId: id,
        candidateId: body.candidateId,
      });
      return NextResponse.json({ removed: body.candidateId });
    }
    if ("action" in body && body.action === "tag") {
      const tags = await tagCandidate({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        candidateId: body.candidateId,
        tags: body.tags,
      });
      return NextResponse.json({ tags });
    }
    const member = await addPoolMember({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      poolId: id,
      candidateId: body.candidateId,
      note: "note" in body ? body.note : undefined,
    });
    return NextResponse.json({ member }, { status: 201 });
  } catch (e) {
    return recruitingErrorResponse(e);
  }
}

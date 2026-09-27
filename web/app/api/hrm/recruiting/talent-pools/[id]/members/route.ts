import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import {
  addPoolMember,
  listPoolMembers,
  removePoolMember,
  tagCandidate,
} from "@openbooks/engine/src/hrm/recruiting/pools.ts";

import { recruitingErrorResponse } from "../../../_lib";
import {
  addPoolMemberBody,
  removePoolMemberBody,
  tagCandidateBody,
} from "../../bodies";
import { z } from "zod";

export const runtime = "nodejs";

const memberActionBody = z.union([
  removePoolMemberBody,
  tagCandidateBody,
  addPoolMemberBody,
]);

/**
 * Pool members: GET lists, POST adds / removes / tags (manage gates in the
 * service). 404s while hrm, hrmRecruiting, or hrmTalentPool is off.
 */
export const GET = defineRoute({
  permission: "hrm.recruiting.read",
  feature: "hrmTalentPool",
  params: z.object({ id: z.string().min(1) }),
  handler: async ({ request: _req, authz: gate, params: routeParams }) => {
    const { id } = routeParams;
    try {
      const members = await listPoolMembers({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        poolId: id,
      });
      return NextResponse.json({ members });
    } catch (e) {
      return recruitingErrorResponse(e);
    }
  },
});

export const POST = defineRoute({
  permission: "hrm.recruiting.manage",
  feature: "hrmTalentPool",
  params: z.object({ id: z.string().min(1) }),
  body: memberActionBody,
  handler: async ({
    request: req,
    authz: gate,
    params: routeParams,
    body: body,
  }) => {
    const { id } = routeParams;

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
  },
});

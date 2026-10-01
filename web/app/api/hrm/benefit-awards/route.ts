import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import {
  createBenefitAward,
  listBenefitAwards,
} from "@openbooks/engine/hrm/benefits";
import { guardPermission } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { notFound } from "@/lib/api/responses";
import { isUuid } from "../../../../lib/list-params";
import { benefitsErrorResponse } from "../benefits/_lib";
import { benefitAwardPostBody } from "./bodies";

export const runtime = "nodejs";

/**
 * Benefit awards: GET lists (optional program filter), POST records a
 * computed award. Creating needs hrm.benefits.manage; the engine rechecks
 * the employment scope and the program entity inside the transaction.
 * Lifecycle moves live under [id].
 */
export const GET = defineRoute({
  permission: "hrm.benefits.read",
  feature: "hrm",
  handler: async ({ request: req, authz: gate }) => {
    const url = new URL(req.url);
    const programId = url.searchParams.get("programId");
    if (programId !== null && !isUuid(programId)) {
      return NextResponse.json({ error: "program id must be a uuid" }, { status: 400 });
    }
    try {
      const limit = url.searchParams.get("limit");
      const offset = url.searchParams.get("offset");
      const { awards, total } = await listBenefitAwards({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        ...(programId ? { programId } : {}),
        ...(limit !== null ? { limit: Number(limit) } : {}),
        ...(offset !== null ? { offset: Number(offset) } : {}),
      });
      return NextResponse.json({ awards, total });
    } catch (e) {
      return benefitsErrorResponse(e);
    }
  },
});

export const POST = defineRoute({
  public: "session",
  body: benefitAwardPostBody,
  handler: async ({ body }) => {
    const gate = await guardPermission("hrm.benefits.manage");
    if (gate instanceof NextResponse) return gate;
    if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
      return notFound("record");
    }
    try {
      const award = await createBenefitAward({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        programId: body.programId,
        employmentId: body.employmentId,
        periodFrom: body.periodFrom,
        periodTo: body.periodTo ?? null,
        value: body.value,
        currency: body.currency,
        evidence: (body.evidence ?? null) as Record<string, unknown> | null,
        sourceKey: body.sourceKey ?? null,
      });
      return NextResponse.json({ award });
    } catch (e) {
      return benefitsErrorResponse(e);
    }
  },
});

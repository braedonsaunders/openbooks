import { z } from "zod";
import { civilDateInput } from "@/lib/api/civil-date";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import {
  activateBenefitProgram,
  addProgramMembership,
  closeBenefitProgram,
  listBenefitApprovalPolicies,
  listProgramMemberships,
  removeProgramMembership,
  updateBenefitProgram,
  getBenefitProgram,
  settleIncentivePeriod,
} from "@openbooks/engine/hrm/benefits";
import { db } from "@openbooks/engine/platform/database";
import { isUuid } from "../../../../../lib/list-params";
import { benefitsErrorResponse } from "../../benefits/_lib";
import { benefitProgramPatchBody } from "../bodies";

/**
 * One employer-defined program: read, edit a draft, activate, close, or
 * manage membership. Reads need hrm.benefits.read; every move needs
 * hrm.benefits.manage with the employment scope rechecked inside the
 * engine transaction.
 */
export const runtime = "nodejs";

export const GET = defineRoute({
  permission: "hrm.benefits.read",
  feature: "hrm",
  params: z.object({ id: z.string().min(1) }),
  handler: async ({ authz: gate, params: routeParams }) => {
    const { id } = routeParams;
    if (!isUuid(id)) return NextResponse.json({ error: "program id must be a uuid" }, { status: 400 });
    try {
      const program = await getBenefitProgram(db, gate.user.orgId, gate.user.id, id);
      const members = await listProgramMemberships({ orgId: gate.user.orgId, actorId: gate.user.id, programId: id });
      const approvalPolicies = await listBenefitApprovalPolicies({ orgId: gate.user.orgId, actorId: gate.user.id, programId: id });
      return NextResponse.json({ program, members, approvalPolicies });
    } catch (e) {
      return benefitsErrorResponse(e);
    }
  },
});

export const PATCH = defineRoute({
  permission: "hrm.benefits.manage",
  feature: "hrm",
  params: z.object({ id: z.string().min(1) }),
  body: benefitProgramPatchBody,
  handler: async ({ authz: gate, params: routeParams, body }) => {
    const { id } = routeParams;
    if (!isUuid(id)) return NextResponse.json({ error: "program id must be a uuid" }, { status: 400 });
    const base = { orgId: gate.user.orgId, actorId: gate.user.id, programId: id };
    try {
      switch (body.action) {
        case "update": {
          const program = await updateBenefitProgram({
            ...base,
            ...body,
            scopeIds: body.scopeIds ?? undefined,
            sourceAccountIds: body.sourceAccountIds ?? undefined,
            reason: body.reason,
          });
          return NextResponse.json({ program });
        }
        case "activate": {
          const program = await activateBenefitProgram(base);
          return NextResponse.json({ program });
        }
        case "close": {
          const program = await closeBenefitProgram({ ...base, reason: body.reason });
          return NextResponse.json({ program });
        }
      }
    } catch (e) {
      return benefitsErrorResponse(e);
    }
  },
});

export const POST = defineRoute({
  permission: "hrm.benefits.manage",
  feature: "hrm",
  params: z.object({ id: z.string().min(1) }),
  body: z.discriminatedUnion("action", [
    z.object({
      action: z.literal("settle"),
      periodFrom: civilDateInput(),
      periodTo: civilDateInput().nullish(),
    }),
    z.object({
      action: z.literal("addMember"),
      employmentId: z.string().refine(isUuid, "must be a valid id"),
      effectiveFrom: civilDateInput(),
      effectiveTo: civilDateInput().nullish(),
      weight: z.string().trim().min(1).max(64).nullish(),
      role: z.string().trim().max(120).nullish(),
    }),
    z.object({
      action: z.literal("removeMember"),
      membershipId: z.string().refine(isUuid, "must be a valid id"),
      reason: z.string().trim().min(1).max(2000),
      effectiveTo: civilDateInput().nullish(),
    }),
  ]),
  handler: async ({ authz: gate, params: routeParams, body }) => {
    const { id } = routeParams;
    if (!isUuid(id)) return NextResponse.json({ error: "program id must be a uuid" }, { status: 400 });
    const base = { orgId: gate.user.orgId, actorId: gate.user.id, programId: id };
    try {
      if (body.action === "settle") {
        const settled = await settleIncentivePeriod({
          orgId: gate.user.orgId,
          actorId: gate.user.id,
          programId: id,
          periodFrom: body.periodFrom,
          periodTo: body.periodTo ?? body.periodFrom,
        });
        return NextResponse.json({ settled });
      }
      if (body.action === "addMember") {
        const member = await addProgramMembership({
          ...base,
          employmentId: body.employmentId,
          effectiveFrom: body.effectiveFrom,
          effectiveTo: body.effectiveTo ?? null,
          weight: body.weight ?? null,
          role: body.role ?? null,
        });
        return NextResponse.json({ member });
      }
      const member = await removeProgramMembership({
        ...base,
        membershipId: body.membershipId,
        reason: body.reason,
        effectiveTo: body.effectiveTo ?? null,
      });
      return NextResponse.json({ member });
    } catch (e) {
      return benefitsErrorResponse(e);
    }
  },
});

import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { createBenefitProgram, listBenefitPrograms } from "@openbooks/engine/hrm/benefits";
import { benefitsErrorResponse } from "../benefits/_lib";
import { createProgramBody } from "./bodies";

export const runtime = "nodejs";

const PROGRAM_STATUSES = ["draft", "active", "closed"] as const;
const PROGRAM_FAMILIES = ["reward", "allowance", "incentive", "custom"] as const;

/**
 * Employer-defined benefit programs: GET lists (optional status/family
 * filters), POST creates a draft. Insured health and retirement stay on
 * benefit plans; this surface never duplicates those tables. Moves on one
 * program live under [id].
 */
export const GET = defineRoute({
  permission: "hrm.benefits.read",
  feature: "hrm",
  handler: async ({ request: req, authz: gate }) => {
    const url = new URL(req.url);
    const status = url.searchParams.get("status");
    const family = url.searchParams.get("family");
    if (status !== null && !(PROGRAM_STATUSES as readonly string[]).includes(status)) {
      return NextResponse.json({ error: "unknown program status" }, { status: 400 });
    }
    if (family !== null && !(PROGRAM_FAMILIES as readonly string[]).includes(family)) {
      return NextResponse.json({ error: "unknown program family" }, { status: 400 });
    }
    try {
      const limit = url.searchParams.get("limit");
      const offset = url.searchParams.get("offset");
      const { programs, total } = await listBenefitPrograms({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        ...(status ? { status: status as (typeof PROGRAM_STATUSES)[number] } : {}),
        ...(family ? { family: family as (typeof PROGRAM_FAMILIES)[number] } : {}),
        ...(limit !== null ? { limit: Number(limit) } : {}),
        ...(offset !== null ? { offset: Number(offset) } : {}),
      });
      return NextResponse.json({ programs, total });
    } catch (e) {
      return benefitsErrorResponse(e);
    }
  },
});

export const POST = defineRoute({
  permission: "hrm.benefits.manage",
  feature: "hrm",
  body: createProgramBody,
  handler: async ({ authz: gate, body }) => {
    try {
      const program = await createBenefitProgram({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        code: body.code,
        reason: body.reason,
        name: body.name,
        family: body.family,
        description: body.description ?? null,
        legalEntityId: body.legalEntityId ?? null,
        currency: body.currency,
        effectiveFrom: body.effectiveFrom,
        effectiveTo: body.effectiveTo ?? null,
        payComponentId: body.payComponentId ?? null,
        deliveryMethod: body.deliveryMethod ?? "payroll",
        valuation: body.valuation ?? "fixed",
        metric: body.metric ?? null,
        metricScope: body.metricScope ?? null,
        scopeIds: body.scopeIds ?? [],
        scopeCustomerIds: body.scopeCustomerIds ?? [],
        scopeDepartmentIds: body.scopeDepartmentIds ?? [],
        unassignedTime: body.unassignedTime ?? "refuse",
        scopeExcludedProjectIds: body.scopeExcludedProjectIds ?? [],
        lossPercentRate: body.lossPercentRate ?? null,
        projectProfitCap: body.projectProfitCap ?? null,
        projectLossCap: body.projectLossCap ?? null,
        poolRounding: body.poolRounding ?? "share",
        includeOpenCommitments: body.includeOpenCommitments ?? false,
        hourClassifications: body.hourClassifications ?? [],
        eligibility: body.eligibility ?? "members",
        allocation: body.allocation ?? "equal",
        percentRate: body.percentRate ?? null,
        fixedAmount: body.fixedAmount ?? null,
        capAmount: body.capAmount ?? null,
        budgetAmount: body.budgetAmount ?? null,
        thresholdAmount: body.thresholdAmount ?? null,
        frequency: body.frequency ?? "manual",
        periodBasis: body.periodBasis ?? null,
        paymentDelayDays: body.paymentDelayDays ?? 0,
        sourceAccountIds: body.sourceAccountIds ?? [],
      });
      return NextResponse.json({ program });
    } catch (e) {
      return benefitsErrorResponse(e);
    }
  },
});

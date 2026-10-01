import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import {
  createBenefitProgram,
  listBenefitPrograms,
} from "@openbooks/engine/hrm/benefits";
import { benefitsErrorResponse } from "../benefits/_lib";

export const runtime = "nodejs";

const PROGRAM_STATUSES = ["draft", "active", "closed"] as const;
const PROGRAM_FAMILIES = ["reward", "allowance", "incentive", "custom"] as const;

const createBody = z.object({
  code: z.string().trim().min(1).max(60),
  name: z.string().trim().min(1).max(200),
  family: z.enum(["reward", "allowance", "incentive", "custom"]),
  description: z.string().trim().max(2000).nullish(),
  legalEntityId: z.string().min(1).nullish(),
  currency: z.string().trim().regex(/^[A-Z]{3}$/, "currency is a 3-letter ISO code in capitals"),
  effectiveFrom: z.string().min(1),
  effectiveTo: z.string().min(1).nullish(),
  payComponentId: z.string().min(1).nullish(),
  deliveryMethod: z.enum(["payroll", "external"]).optional(),
  valuation: z.enum(["fixed", "percent", "pool"]).optional(),
  metric: z.enum(["revenue", "gross_profit", "net_profit", "approved_hours"]).nullish(),
  metricScope: z.enum(["company", "department", "project"]).nullish(),
  scopeIds: z.array(z.string().min(1)).max(100).nullish(),
  allocation: z.enum(["equal", "hours", "role"]).optional(),
  percentRate: z.string().trim().min(1).max(64).nullish(),
  fixedAmount: z.string().trim().min(1).max(64).nullish(),
  capAmount: z.string().trim().min(1).max(64).nullish(),
  budgetAmount: z.string().trim().min(1).max(64).nullish(),
  thresholdAmount: z.string().trim().min(1).max(64).nullish(),
  frequency: z.enum(["monthly", "quarterly", "annual", "project_complete", "manual"]).optional(),
  periodBasis: z.enum(["calendar", "fiscal"]).nullish(),
  paymentDelayDays: z.number().int().min(0).max(3650).optional(),
  sourceAccountIds: z.array(z.string().min(1)).max(100).nullish(),
});

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
  body: createBody,
  handler: async ({ authz: gate, body }) => {
    try {
      const program = await createBenefitProgram({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        code: body.code,
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

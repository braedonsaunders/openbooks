import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { db } from "@openbooks/engine/platform/db";
import {
  LossOfControlProposalError,
  loadLossOfControlProposalData,
  proposeLossOfControl,
} from "@openbooks/engine/consolidation/loss-of-control";
import { isIsoCalendarDate } from "@openbooks/engine/platform/business-date/module";
import { exactMoney, parseJsonBody } from "@/lib/api/json";
import { isUuid } from "@/lib/list-params";
export const runtime = "nodejs";
const rate = z.string().max(40);
const lossOfControlSchema = z.object({
  effectiveOn: z.string().refine(isIsoCalendarDate, "enter a calendar date"),
  reason: z.string().trim().min(8).max(1000),
  idempotencyKey: z.string().min(1).max(120),
  assessment: z.string().trim().min(8).max(4000),
  ociAssessment: z.string().trim().min(8).max(4000),
  eliminationSubsidiaryId: uuidString(),
  proceeds: exactMoney(),
  proceedsAccountId: uuidString(),
  parentInvestmentCarrying: exactMoney(),
  parentRetainedCarrying: exactMoney(),
  parentToGroupRate: rate,
  investmentTranslationAccountId: uuidString(),
  retainedFairValue: exactMoney(),
  retainedPercent: exactMoney(),
  retainedMethod: z.enum(["none", "equity", "financial_asset"]),
  retainedAccountId: uuidString(),
  gainLossAccountId: uuidString(),
  parentGainLossAccountId: uuidString(),
  equityIncomeAccountId: uuidString(),
  distributionAccountId: uuidString().nullable(),
  distributionIncomeAccountId: uuidString().nullable(),
  rates: z
    .array(z.object({ subsidiaryId: uuidString(), rate }))
    .min(1)
    .max(1000),
  additionalConsolidationLines: z
    .array(z.object({ lineId: uuidString(), amount: exactMoney() }))
    .max(2000),
  oci: z
    .array(
      z.object({
        accountId: uuidString(),
        balance: exactMoney(),
        treatment: z.enum(["profit_loss", "retained_earnings"]),
        destinationAccountId: uuidString(),
        description: z.string().trim().min(1).max(1000),
      }),
    )
    .max(100),
});
export const GET = defineRoute({
  permission: "close.run",
  feature: "multiSubsidiary",
  handler: async ({ request: _req, authz: routeAuthz, params: routeParams }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const gate = routeAuthz;
    const { id } = await params;
    if (!isUuid(id))
      return NextResponse.json({ error: "invalid ownership interest" }, { status: 422 });
    const orgId = gate.user.orgId;
    try {
      return NextResponse.json(
        await loadLossOfControlProposalData(db, orgId, id, gate.allowedSubsidiaryIds),
      );
    } catch (e) {
      if (e instanceof LossOfControlProposalError) return apiErrorResponse(e);
      throw e;
    }
  },
});
export const POST = defineRoute({
  permission: "close.run",
  feature: "multiSubsidiary",
  handler: async ({ request: req, authz: routeAuthz, params: routeParams }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const gate = routeAuthz;
    const { id } = await params;
    if (!isUuid(id))
      return NextResponse.json({ error: "invalid ownership interest" }, { status: 422 });
    const body = await parseJsonBody(req, lossOfControlSchema, { status: 422 });
    if (!body.ok) return body.response;
    try {
      return NextResponse.json({
        changeId: await proposeLossOfControl(gate.user.orgId, id, gate.user.id, body.data),
      });
    } catch (e) {
      return apiErrorResponse(e);
    }
  },
});

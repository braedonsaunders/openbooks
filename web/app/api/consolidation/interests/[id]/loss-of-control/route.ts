import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@openbooks/engine/src/platform/db.ts";
import {
  LossOfControlProposalError,
  loadLossOfControlProposalData,
  proposeLossOfControl,
} from "@openbooks/engine/src/consolidation/loss-of-control.ts";
import { isIsoCalendarDate } from "@openbooks/engine/src/platform/business-date.ts";
import { guardFeaturePermission } from "@/lib/feature-gates";
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
  eliminationSubsidiaryId: z.uuid(),
  proceeds: exactMoney(),
  proceedsAccountId: z.uuid(),
  parentInvestmentCarrying: exactMoney(),
  parentRetainedCarrying: exactMoney(),
  parentToGroupRate: rate,
  investmentTranslationAccountId: z.uuid(),
  retainedFairValue: exactMoney(),
  retainedPercent: exactMoney(),
  retainedMethod: z.enum(["none", "equity", "financial_asset"]),
  retainedAccountId: z.uuid(),
  gainLossAccountId: z.uuid(),
  parentGainLossAccountId: z.uuid(),
  equityIncomeAccountId: z.uuid(),
  distributionAccountId: z.uuid().nullable(),
  distributionIncomeAccountId: z.uuid().nullable(),
  rates: z
    .array(z.object({ subsidiaryId: z.uuid(), rate }))
    .min(1)
    .max(1000),
  additionalConsolidationLines: z
    .array(z.object({ lineId: z.uuid(), amount: exactMoney() }))
    .max(2000),
  oci: z
    .array(
      z.object({
        accountId: z.uuid(),
        balance: exactMoney(),
        treatment: z.enum(["profit_loss", "retained_earnings"]),
        destinationAccountId: z.uuid(),
        description: z.string().trim().min(1).max(1000),
      }),
    )
    .max(100),
});
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await guardFeaturePermission("close.run", "multiSubsidiary");
  if (gate instanceof NextResponse) return gate;
  const { id } = await params;
  if (!isUuid(id))
    return NextResponse.json(
      { error: "invalid ownership interest" },
      { status: 422 },
    );
  const orgId = gate.user.orgId;
  try {
    return NextResponse.json(
      await loadLossOfControlProposalData(
        db,
        orgId,
        id,
        gate.allowedSubsidiaryIds,
      ),
    );
  } catch (e) {
    if (e instanceof LossOfControlProposalError)
      return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await guardFeaturePermission("close.run", "multiSubsidiary");
  if (gate instanceof NextResponse) return gate;
  const { id } = await params;
  if (!isUuid(id))
    return NextResponse.json(
      { error: "invalid ownership interest" },
      { status: 422 },
    );
  const body = await parseJsonBody(req, lossOfControlSchema, { status: 422 });
  if (!body.ok) return body.response;
  try {
    return NextResponse.json({
      changeId: await proposeLossOfControl(
        gate.user.orgId,
        id,
        gate.user.id,
        body.data,
      ),
    });
  } catch (e) {
    return NextResponse.json(
      {
        error:
          e instanceof Error
            ? e.message
            : "loss of control could not be proposed",
      },
      { status: 422 },
    );
  }
}

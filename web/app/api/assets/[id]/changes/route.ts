import { NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { proposeAssetChange } from "@openbooks/engine/src/assets/asset-changes.ts";
import { isIsoCalendarDate } from "@openbooks/engine/src/platform/business-date.ts";
import { guardFeaturePermission } from "@/lib/feature-gates";
import { exactMoney, parseJsonBody } from "@/lib/api/json";
import { isUuid } from "@/lib/list-params";
export const runtime = "nodejs";
const date = z.string().refine(isIsoCalendarDate, "enter a calendar date");
const plan = z.array(z.object({ date, amount: exactMoney() })).max(1200);
const groupComponent = z.object({
  cost: exactMoney(),
  accumulated: exactMoney(),
  salvage: exactMoney(),
  remainingPlan: plan,
  removedPlan: plan.optional(),
  unimpairedAccumulated: exactMoney().optional(),
  unimpairedRemainingPlan: plan.optional(),
  unimpairedRemovedPlan: plan.optional(),
});
const assetChangeSchema = z.object({
  operation: z.enum(["partial_disposal", "intercompany_transfer"]),
  effectiveOn: date,
  reason: z.string().trim().min(8).max(1000),
  idempotencyKey: z.string().min(1).max(120),
  assessment: z.string().trim().min(8).max(4000),
  portion: z.union([
    z.object({ percent: exactMoney() }),
    z.object({
      books: z
        .array(
          z.object({
            bookId: z.uuid(),
            cost: exactMoney(),
            accumulated: exactMoney(),
            salvage: exactMoney(),
            remainingProductionUnits: exactMoney().optional(),
            group: groupComponent.optional(),
          }),
        )
        .min(1)
        .max(100),
    }),
  ]),
  proceeds: exactMoney(),
  proceedsAccountId: z.uuid(),
  transfer: z
    .object({
      subsidiaryId: z.uuid(),
      categoryId: z.uuid(),
      assetNumber: z.string().trim().min(1).max(100),
      name: z.string().trim().min(1).max(255),
      buyerAmount: exactMoney(),
      buyerSalvage: exactMoney(),
      buyerProductionUnits: exactMoney().optional(),
      lifeMonths: z.number().int().min(1).max(1200),
      payableAccountId: z.uuid(),
      eliminationSubsidiaryId: z.uuid(),
      sellerToGroupRate: z.string().max(40),
      buyerToGroupRate: z.string().max(40),
      sellerToBuyerRate: z.string().max(40),
      ctaAccountId: z.uuid(),
      groupAssetAccountId: z.uuid(),
      groupAccumulatedAccountId: z.uuid(),
      groupDepreciationAccountId: z.uuid(),
      groupGainLossAccountId: z.uuid(),
      taxRatePercent: exactMoney(),
      deferredTaxAccountId: z.uuid(),
      taxExpenseAccountId: z.uuid(),
      exchangeRateEvidence: z.string().trim().min(8).max(4000),
      groupAssessment: z.string().trim().min(8).max(4000),
      groupPlans: z
        .array(
          z.object({
            bookId: z.uuid(),
            lines: z.array(z.object({ date, amount: exactMoney() })).max(1200),
          }),
        )
        .max(100)
        .optional(),
    })
    .optional(),
});
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await guardFeaturePermission("assets.manage", "fixedAssets");
  if (gate instanceof NextResponse) return gate;
  const { id } = await params;
  if (!isUuid(id))
    return NextResponse.json({ error: "invalid asset" }, { status: 422 });
  const orgId = gate.user.orgId;
  const asset = (
    await db.execute<{ subsidiary_id: string }>(
      sql`select subsidiary_id from fixed_assets where org_id=${orgId} and id=${id}`,
    )
  ).rows[0];
  if (
    !asset ||
    (gate.allowedSubsidiaryIds &&
      !gate.allowedSubsidiaryIds.has(asset.subsidiary_id))
  )
    return NextResponse.json({ error: "asset not found" }, { status: 404 });
  const subsidiaries = (
    await db.execute<{
      id: string;
      name: string;
      base_currency: string;
      is_elimination: boolean;
    }>(
      sql`select id,name,base_currency,is_elimination from subsidiaries where org_id=${orgId} and is_active order by name`,
    )
  ).rows.filter(
    (s) => !gate.allowedSubsidiaryIds || gate.allowedSubsidiaryIds.has(s.id),
  );
  const books = (
    await db.execute<{ id: string; name: string }>(
      sql`select id,name from accounting_books where org_id=${orgId} and is_active order by is_primary desc,name`,
    )
  ).rows;
  const groupBooks = (
    await db.execute<{ book_id: string; group_currency: string }>(
      sql`select book_id,group_currency from asset_transfer_bases where org_id=${orgId} and receiving_asset_id=${id} and reversed_by_change_id is null order by book_id`,
    )
  ).rows;
  const groupScope = (
    await db.execute<{ elimination_subsidiary_id: string }>(
      sql`select distinct elimination_subsidiary_id from asset_transfer_bases where org_id=${orgId} and receiving_asset_id=${id} and reversed_by_change_id is null`,
    )
  ).rows;
  if (
    gate.allowedSubsidiaryIds &&
    groupScope.some(
      (s) => !gate.allowedSubsidiaryIds!.has(s.elimination_subsidiary_id),
    )
  )
    return NextResponse.json(
      {
        error:
          "this asset change includes a group entity outside your authorization",
      },
      { status: 403 },
    );
  return NextResponse.json({ subsidiaries, books, groupBooks });
}
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await guardFeaturePermission("assets.manage", "fixedAssets");
  if (gate instanceof NextResponse) return gate;
  const { id } = await params;
  if (!isUuid(id))
    return NextResponse.json({ error: "invalid asset" }, { status: 422 });
  const body = await parseJsonBody(req, assetChangeSchema, { status: 422 });
  if (!body.ok) return body.response;
  try {
    return NextResponse.json({
      changeId: await proposeAssetChange(
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
          e instanceof Error ? e.message : "asset change could not be proposed",
      },
      { status: 422 },
    );
  }
}

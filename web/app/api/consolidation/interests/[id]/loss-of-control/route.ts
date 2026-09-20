import { NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { proposeLossOfControl } from "@openbooks/engine/src/consolidation/loss-of-control.ts";
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
  const interest = (
    await db.execute<{
      subsidiary_id: string;
      parent_subsidiary_id: string;
      investment_account_id: string;
      equity_income_account_id: string;
    }>(
      sql`select * from subsidiary_ownership_interests where org_id=${orgId} and id=${id}`,
    )
  ).rows[0];
  if (
    !interest ||
    (gate.allowedSubsidiaryIds &&
      (!gate.allowedSubsidiaryIds.has(interest.subsidiary_id) ||
        !gate.allowedSubsidiaryIds.has(interest.parent_subsidiary_id)))
  )
    return NextResponse.json(
      { error: "ownership interest not found" },
      { status: 404 },
    );
  const subsidiaries = (
    await db.execute<{
      id: string;
      name: string;
      parent_id: string | null;
      base_currency: string;
      is_elimination: boolean;
    }>(
      sql`with recursive family as(select id,org_id,name,parent_id,base_currency,is_elimination from subsidiaries where org_id=${orgId} and id=${interest.subsidiary_id} union all select s.id,s.org_id,s.name,s.parent_id,s.base_currency,s.is_elimination from subsidiaries s join family f on f.org_id=s.org_id and s.parent_id=f.id where not s.is_elimination) select * from family order by name`,
    )
  ).rows;
  if (
    gate.allowedSubsidiaryIds &&
    subsidiaries.some((s) => !gate.allowedSubsidiaryIds!.has(s.id))
  )
    return NextResponse.json(
      { error: "this disposal includes an entity outside your authorization" },
      { status: 403 },
    );
  const accounts = (
    await db.execute<{
      id: string;
      number: string;
      name: string;
      type: string;
    }>(
      sql`select id,number,name,type from accounts where org_id=${orgId} and is_active and not is_summary order by number`,
    )
  ).rows;
  const eliminations = (
    await db.execute<{ id: string; name: string; base_currency: string }>(
      sql`select id,name,base_currency from subsidiaries where org_id=${orgId} and is_active and is_elimination order by name`,
    )
  ).rows.filter(
    (s) => !gate.allowedSubsidiaryIds || gate.allowedSubsidiaryIds.has(s.id),
  );
  const adjustmentLines = eliminations.length
    ? (
        await db.execute<{
          id: string;
          entry_number: string;
          posting_date: string;
          account_name: string;
          amount: string;
          memo: string | null;
        }>(
          sql`select l.id,e.entry_number,e.posting_date::text,a.name as account_name,l.amount::text,l.memo from journal_entries e join journal_lines l on l.org_id=e.org_id and l.entry_id=e.id join accounts a on a.org_id=l.org_id and a.id=l.account_id where e.org_id=${orgId} and e.subsidiary_id in(select jsonb_array_elements_text(${JSON.stringify(eliminations.map((s) => s.id))}::jsonb)::uuid) and e.status in('posted','reversed') and not exists(select 1 from ownership_consolidation_entries c where c.org_id=e.org_id and c.journal_entry_id=e.id) and not exists(select 1 from asset_transfer_consolidation_entries c where c.org_id=e.org_id and c.journal_entry_id=e.id) order by e.posting_date desc,e.entry_number,l.line_number`,
        )
      ).rows
    : [];
  return NextResponse.json({
    interest,
    subsidiaries,
    accounts,
    eliminations,
    adjustmentLines,
  });
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

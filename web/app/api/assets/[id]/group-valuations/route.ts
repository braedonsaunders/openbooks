import { NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { isIsoCalendarDate } from "@openbooks/engine/src/platform/business-date.ts";
import { proposeAssetGroupValuation } from "@openbooks/engine/src/assets/group-valuations.ts";
import { guardFeaturePermission } from "@/lib/feature-gates";
import { isUuid } from "@/lib/list-params";
import { exactMoney, parseJsonBody } from "@/lib/api/json";
export const runtime = "nodejs";
const date = z.string().refine(isIsoCalendarDate, "enter a calendar date");
const proposal = z.object({
  sourceEventId: z.uuid(),
  effectiveOn: date,
  carryingValue: exactMoney(),
  buyerToGroupRate: z.string().min(1).max(40),
  assessment: z.string().trim().min(8).max(4000),
  reason: z.string().trim().min(8).max(1000),
  idempotencyKey: z.string().min(1).max(120),
  remainingPlan: z.array(z.object({ date, amount: exactMoney() })).max(1200),
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
  const rows = (
    await db.execute<{
      id: string;
      date: string;
      kind: string;
      amount: string;
      book_name: string;
      group_currency: string;
      subsidiary_id: string;
      elimination_subsidiary_id: string;
      recorded: boolean;
    }>(
      sql`select v.id,v.occurred_on::text as date,v.kind,v.amount::text,b.name as book_name,t.group_currency,a.subsidiary_id,t.elimination_subsidiary_id,exists(select 1 from asset_transfer_measurements m where m.org_id=v.org_id and m.source_event_id=v.id) as recorded from fixed_assets a join asset_events v on v.org_id=a.org_id and v.asset_id=a.id join journal_entries e on e.org_id=v.org_id and e.id=v.journal_entry_id join accounting_books b on b.org_id=e.org_id and b.id=e.book_id join asset_transfer_bases t on t.org_id=a.org_id and t.receiving_asset_id=a.id and t.book_id=e.book_id where a.org_id=${gate.user.orgId} and a.id=${id} and t.reversed_by_change_id is null and v.kind in('impaired','revalued') and e.status='posted' and not exists(select 1 from asset_events r where r.org_id=v.org_id and r.reverses_event_id=v.id) order by v.occurred_on,v.created_at,v.id`,
    )
  ).rows.filter(
    (row) =>
      !gate.allowedSubsidiaryIds ||
      (gate.allowedSubsidiaryIds.has(row.subsidiary_id) &&
        gate.allowedSubsidiaryIds.has(row.elimination_subsidiary_id)),
  );
  return NextResponse.json({
    events: rows.map((row) => ({
      id: row.id,
      date: row.date,
      kind: row.kind,
      amount: row.amount,
      book_name: row.book_name,
      group_currency: row.group_currency,
      recorded: row.recorded,
    })),
  });
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
  const body = await parseJsonBody(req, proposal, { status: 422 });
  if (!body.ok) return body.response;
  try {
    const changeId = await proposeAssetGroupValuation(
      gate.user.orgId,
      id,
      gate.user.id,
      body.data,
    );
    return NextResponse.json({ changeId }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "group valuation could not be proposed",
      },
      { status: 422 },
    );
  }
}

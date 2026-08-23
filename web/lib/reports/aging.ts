import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { resolveOrgId } from "../org-scope";
import { decimalAdd, type ExactDecimal } from "../statement-format";
import { ZERO } from "./decimals";
import { type DimFilter, dimWhere } from "./filters";

// ---------------------------------------------------------------------------
// AR / AP Aging
// ---------------------------------------------------------------------------

export type AgingSide = "ar" | "ap";

/** The five aging buckets, oldest last. `age` is days past due (or since posting). */
export interface AgingRow {
  partyId: string | null;
  partyName: string | null;
  current: ExactDecimal; // not yet due (age <= 0)
  b1: ExactDecimal; // 1–30
  b2: ExactDecimal; // 31–60
  b3: ExactDecimal; // 61–90
  b4: ExactDecimal; // 90+
  total: ExactDecimal;
}

export interface AgingResult {
  rows: AgingRow[];
  totals: Omit<AgingRow, "partyId" | "partyName">;
  asOf: string;
}

/**
 * Per-party document aging from the canonical maintained open balance. Source
 * migrations often contain complete remaining balances but not the historical
 * application rows needed to reconstruct them from gross ledger lines. Aging
 * those lines therefore wildly overstates imported AR/AP. `documents.open_balance`
 * is updated by native applications and imported from the source for cutover,
 * so it is the only source that is correct for both paths. Credits reduce the
 * party balance and all values are translated to base currency at document FX.
 */
export async function agingByParty(side: AgingSide, asOf: string, dims?: DimFilter, orgId?: string): Promise<AgingResult> {
  const resolvedOrgId = await resolveOrgId(orgId);
  const positiveKind = side === "ap" ? "vendor_bill" : "customer_invoice";
  const creditKind = side === "ap" ? "vendor_credit" : "customer_credit";
  const r = (await db.execute<{
      party_id: string | null; party_name: string | null;
      current: string; b1: string; b2: string; b3: string; b4: string; total: string;
    }>(sql`
    with open_items as (
      select d.party_id,
             (case when d.kind = ${creditKind} then -1 else 1 end)
               * d.open_balance * d.fx_rate as open,
             (${asOf}::date - coalesce(d.due_date, d.posting_date, d.document_date)) as age_days
        from documents d
       where d.org_id = ${resolvedOrgId}
         and d.status = 'posted' and d.kind in (${positiveKind}, ${creditKind})
         and d.open_balance > 0
         and coalesce(d.posting_date, d.document_date) <= ${asOf}
         and ${dimWhere(dims, sql`d`)}
    )
    select oi.party_id, p.display_name as party_name,
           coalesce(sum(oi.open) filter (where oi.age_days <= 0), 0) as current,
           coalesce(sum(oi.open) filter (where oi.age_days between 1 and 30), 0) as b1,
           coalesce(sum(oi.open) filter (where oi.age_days between 31 and 60), 0) as b2,
           coalesce(sum(oi.open) filter (where oi.age_days between 61 and 90), 0) as b3,
           coalesce(sum(oi.open) filter (where oi.age_days > 90), 0) as b4,
           coalesce(sum(oi.open), 0) as total
      from open_items oi
      left join parties p on p.id = oi.party_id and p.org_id = ${resolvedOrgId}
     group by oi.party_id, p.display_name
    having abs(sum(oi.open)) > 0
     order by abs(sum(oi.open)) desc
  `));
  const rows: AgingRow[] = r.rows.map((x) => ({
    partyId: x.party_id,
    partyName: x.party_name,
    current: x.current,
    b1: x.b1,
    b2: x.b2,
    b3: x.b3,
    b4: x.b4,
    total: x.total,
  }));
  const totals = rows.reduce(
    (a, r) => ({
      current: decimalAdd(a.current, r.current),
      b1: decimalAdd(a.b1, r.b1),
      b2: decimalAdd(a.b2, r.b2),
      b3: decimalAdd(a.b3, r.b3),
      b4: decimalAdd(a.b4, r.b4),
      total: decimalAdd(a.total, r.total),
    }),
    { current: ZERO, b1: ZERO, b2: ZERO, b3: ZERO, b4: ZERO, total: ZERO },
  );
  return { rows, totals, asOf };
}

// ---------------------------------------------------------------------------
// AR / AP Aging Detail — one row per open item (invoice/bill), bucketed
// ---------------------------------------------------------------------------

export type AgingBucket = "current" | "b1" | "b2" | "b3" | "b4"

export interface AgingDetailRow {
  docId: string
  docKind: string
  partyId: string | null
  partyName: string | null
  reference: string | null
  dueDate: string | null
  ageDays: number
  bucket: AgingBucket
  open: ExactDecimal
}
export interface AgingDetailResult {
  rows: AgingDetailRow[]
  totals: Record<AgingBucket, ExactDecimal> & { total: ExactDecimal }
  asOf: string
}

function bucketOf(age: number): AgingBucket {
  if (age <= 0) return "current"
  if (age <= 30) return "b1"
  if (age <= 60) return "b2"
  if (age <= 90) return "b3"
  return "b4"
}

/**
 * Per-open-item aging: the same canonical document-balance logic as
 * `agingByParty`, but one row per document rather than aggregated per party.
 * Credits are negative open items so the detail and summary always tie.
 */
export async function agingDetail(side: AgingSide, asOf: string, dims?: DimFilter, orgId?: string): Promise<AgingDetailResult> {
  const resolvedOrgId = await resolveOrgId(orgId);
  const positiveKind = side === "ap" ? "vendor_bill" : "customer_invoice"
  const creditKind = side === "ap" ? "vendor_credit" : "customer_credit"
  const r = (await db.execute<{
      id: string; kind: string
      party_id: string | null; party_name: string | null; reference: string | null
      due_date: string | null; age_days: number; open: string
    }>(sql`
    with open_items as (
      select d.id, d.kind, d.party_id, d.document_number,
             coalesce(d.due_date, d.posting_date, d.document_date)::text as due,
             (case when d.kind = ${creditKind} then -1 else 1 end)
               * d.open_balance * d.fx_rate as open,
             (${asOf}::date - coalesce(d.due_date, d.posting_date, d.document_date))::int as age_days
        from documents d
       where d.org_id = ${resolvedOrgId}
         and d.status = 'posted' and d.kind in (${positiveKind}, ${creditKind})
         and d.open_balance > 0
         and coalesce(d.posting_date, d.document_date) <= ${asOf}
         and ${dimWhere(dims, sql`d`)}
    )
    select oi.id, oi.kind, oi.party_id, p.display_name as party_name, oi.document_number as reference,
           oi.due as due_date, oi.age_days, oi.open
      from open_items oi
      left join parties p on p.id = oi.party_id and p.org_id = ${resolvedOrgId}
     where abs(oi.open) > 0
     order by p.display_name nulls last, oi.age_days desc
  `))
  const totals: Record<AgingBucket, ExactDecimal> & { total: ExactDecimal } = { current: ZERO, b1: ZERO, b2: ZERO, b3: ZERO, b4: ZERO, total: ZERO }
  const rows: AgingDetailRow[] = r.rows.map((x) => {
    const open = x.open
    const bucket = bucketOf(x.age_days)
    totals[bucket] = decimalAdd(totals[bucket], open)
    totals.total = decimalAdd(totals.total, open)
    return { docId: x.id, docKind: x.kind, partyId: x.party_id, partyName: x.party_name, reference: x.reference, dueDate: x.due_date, ageDays: x.age_days, bucket, open }
  })
  return { rows, totals, asOf }
}

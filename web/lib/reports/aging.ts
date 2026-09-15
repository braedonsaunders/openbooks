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
             -- Ledger scale is 4dp but the translation carries up to 14; round
             -- once here so bucket sums and the JS exact-decimal rollup below
             -- agree (unrounded values throw past 4dp) and always tie.
             -- The open is reconstructed AS OF the report date — gross
             -- open-item lines minus applications dated on/before it — never
             -- the live cached balance: a later settlement must not rewrite a
             -- past aging (or month-end history would never reproduce).
             round((case when d.kind = ${creditKind} then -1 else 1 end)
               * (gross.gross - coalesce(applied.applied, 0)) * d.fx_rate, 4) as open,
             (${asOf}::date - coalesce(d.due_date, d.posting_date, d.document_date)) as age_days
        from documents d
        left join lateral (
          select coalesce(sum(abs(jl.txn_amount)), 0) as gross
            from journal_lines jl
           where jl.entry_id = d.posted_entry_id and jl.is_open_item
        ) gross on true
        left join lateral (
          select sum(case when a.from_line_id = jl.id
                          then a.source_transaction_amount
                          else a.target_transaction_amount end) as applied
            from journal_lines jl
            join applications a on a.org_id = ${resolvedOrgId}
              and (a.from_line_id = jl.id or a.to_line_id = jl.id)
           where jl.entry_id = d.posted_entry_id and jl.is_open_item
             and a.applied_on <= ${asOf}
             and (a.unapplied_at is null or a.unapplied_at::date > ${asOf}::date)
        ) applied on true
       where d.org_id = ${resolvedOrgId}
         and d.status = 'posted' and d.kind in (${positiveKind}, ${creditKind})
         and (gross.gross - coalesce(applied.applied, 0)) > 0
         and coalesce(d.posting_date, d.document_date) <= ${asOf}
         and ${dimWhere(dims, sql`d`)}
    )
    select oi.party_id, p.display_name as party_name,
           coalesce(sum(oi.open) filter (where oi.age_days <= 0), 0) as current,
           coalesce(sum(oi.open) filter (where oi.age_days between 1 and 30), 0) as b1,
           coalesce(sum(oi.open) filter (where oi.age_days between 31 and 60), 0) as b2,
           coalesce(sum(oi.open) filter (where oi.age_days between 61 and 89), 0) as b3,
           coalesce(sum(oi.open) filter (where oi.age_days >= 90), 0) as b4,
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

export function bucketOf(age: number): AgingBucket {
  if (age <= 0) return "current"
  if (age <= 30) return "b1"
  if (age <= 60) return "b2"
  if (age < 90) return "b3"
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
             -- Same 4dp ledger-scale rounding as the summary so detail rows
             -- never carry precision the exact-decimal rollup cannot hold, and
             -- the same as-of reconstruction: gross lines minus applications
             -- dated on/before the report date, never the live cached balance.
             round((case when d.kind = ${creditKind} then -1 else 1 end)
               * (gross.gross - coalesce(applied.applied, 0)) * d.fx_rate, 4) as open,
             (${asOf}::date - coalesce(d.due_date, d.posting_date, d.document_date))::int as age_days
        from documents d
        left join lateral (
          select coalesce(sum(abs(jl.txn_amount)), 0) as gross
            from journal_lines jl
           where jl.entry_id = d.posted_entry_id and jl.is_open_item
        ) gross on true
        left join lateral (
          select sum(case when a.from_line_id = jl.id
                          then a.source_transaction_amount
                          else a.target_transaction_amount end) as applied
            from journal_lines jl
            join applications a on a.org_id = ${resolvedOrgId}
              and (a.from_line_id = jl.id or a.to_line_id = jl.id)
           where jl.entry_id = d.posted_entry_id and jl.is_open_item
             and a.applied_on <= ${asOf}
             and (a.unapplied_at is null or a.unapplied_at::date > ${asOf}::date)
        ) applied on true
       where d.org_id = ${resolvedOrgId}
         and d.status = 'posted' and d.kind in (${positiveKind}, ${creditKind})
         and (gross.gross - coalesce(applied.applied, 0)) > 0
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

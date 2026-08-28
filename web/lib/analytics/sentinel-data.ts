import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { analyticsConfig } from "./config";

/**
 * Sentinel — transaction integrity forensics re-engineered for scale.
 *
 * Every forensic test runs as set-based SQL over the full ledger — window functions for
 * per-vendor baselines (RSF, z-score), gaps-and-islands for sequential
 * invoice runs, set-based self-join for duplicates, GROUP BY digit for
 * Benford — so any period over any dataset size returns aggregates, with
 * only the top-N detail rows per detector shipped to the client.
 *
 * Tests and default thresholds:
 *  - Duplicates: same vendor + same doc kind + same amount within 14 days
 *    (≥$100, credits excluded); confidence by memo/date proximity.
 *  - Benford first-digit + first-two-digit distributions with Mean Absolute
 *    Deviation conformity bands (Nigrini), over EVERY spend document.
 *  - Threshold trap: amounts ending 99 / 999 / 9999 (approval-limit gaming).
 *  - Weekend documents: spend documents dated Saturday or Sunday, using the
 *    accounting date rather than an import timestamp.
 *  - RSF: amount ÷ vendor's historical 2nd-largest (36-month baseline) ≥ 10.
 *  - Z-score: |amount − vendor mean| / vendor σ ≥ 3 (baseline ≥ 5 txns, σ>10).
 *  - Sequential invoices: gap-free vendor reference-number runs spread over
 *    7+ days — the shell-company / sole-customer indicator.
 *  - Ghost vendors: the two-phase detector — employee names matched
 *    against vendor names AND normalized street addresses (line1 + postal)
 *    shared between a paid vendor and an employee (name 75 / addr 90 / both 95).
 *  - Audit trail: native audit_log events on parties/documents (deletes,
 *    banking/contact changes).
 */

const SPEND_KINDS = ["vendor_bill", "vendor_credit", "vendor_payment", "check", "expense_report", "journal", "customer_credit"] as const;

// Fixed detection constants. Duplicate/sequential thresholds are per-org
// configurable (lib/analytics/config.ts) — these are the fixed ones.
const HIGH_RISK_AMOUNT = 10_000;
const CRITICAL_RISK_AMOUNT = 25_000;
const Z_SCORE_THRESHOLD = 3;
const RSF_THRESHOLD = 10;
const SEQUENTIAL_HIGH_RISK_DAYS = 30;

const BENFORD_1D: Record<number, number> = {
  1: 0.30103, 2: 0.17609, 3: 0.12494, 4: 0.09691, 5: 0.07918, 6: 0.06695, 7: 0.05799, 8: 0.05115, 9: 0.04576,
};

// ---- shapes -----------------------------------------------------------------

export interface FlaggedDoc {
  docId: string;
  docNumber: string;
  kind: string;
  date: string;
  amount: number;
  partyId: string | null;
  partyName: string;
  flagType: "duplicate" | "weekend" | "rsf" | "zscore" | "trap" | "sequential";
  reason: string;
  riskScore: number;
}

export interface DuplicatePair {
  docId1: string; docId2: string; docNumber1: string; docNumber2: string;
  kind: string; date1: string; date2: string; daysBetween: number;
  amount: number; partyId: string | null; partyName: string;
  sameMemo: boolean; confidence: number; riskScore: number;
}

export interface BenfordDigit {
  digit: number;
  count: number;
  amount: number;
  observed: number;
  expected: number;
  deviationPct: number;
  isAnomaly: boolean;
}

export interface SequentialGroup {
  partyId: string; partyName: string; count: number; totalAmount: number;
  startRef: number; endRef: number; dateSpanDays: number;
  firstDate: string; lastDate: string;
  riskLevel: "high" | "medium"; riskScore: number; reason: string;
  invoices: { docId: string; docNumber: string; reference: string; date: string; amount: number }[];
}

export interface GhostVendor {
  vendorId: string; vendorName: string; employeeId: string; employeeName: string;
  matchType: "name" | "address" | "name+address"; riskScore: number; reason: string;
}

export interface AuditEvent {
  id: string; tableName: string; rowId: string; action: string; actorId: string | null; at: string; summary: string;
}

interface AggregateRow extends Record<string, string | number | null> {
  count: string | number;
  amount: string | number;
}
interface FlaggedDocumentRow extends Record<string, unknown> {
  id: string; document_number: string | null; kind: string; date: string; amount: string | number;
  party_id: string | null; party_name: string | null; trap?: string; dow?: string | number;
}
interface DuplicateRow extends Record<string, unknown> {
  id1: string; id2: string; num1: string | null; num2: string | null; kind: string;
  date1: string; date2: string; days_between: string | number; amount: string | number;
  party_id: string | null; party_name: string; same_memo: boolean;
}
interface VendorStatisticRow extends FlaggedDocumentRow {
  rsf?: string | number; z?: string | number; second_amount: string | number;
  baseline_count: string | number; avg_amount: string | number; std_amount: string | number;
}
interface SequentialRow extends Record<string, unknown> {
  party_id: string; party_name: string; span_days: string | number; cnt: string | number;
  total_amount: string | number; start_ref: string | number; end_ref: string | number;
  first_date: string; last_date: string;
  invoices: Array<{ docId: string; docNumber: string; reference: string; date: string; amount: number }>;
}
interface GhostRow extends Record<string, unknown> {
  vendor_id: string; vendor_name: string; employee_id: string; employee_name: string;
  name_match: boolean; address_match: boolean;
}
interface AuditRow extends Record<string, unknown> {
  id: string; table_name: string; row_id: string; action: string; actor_id: string | null;
  at: string; changes: string | null;
}

export interface SentinelData {
  period: { from: string; to: string; label: string };
  meta: { totalDocs: number; totalAmount: number; days: number; queryMs: number };
  config: Record<string, number>;
  summary: {
    flaggedCount: number;
    duplicateCount: number;
    totalDuplicateAmount: number;
    weekendCount: number;
    weekendAmount: number;
    rsfCount: number;
    zScoreCount: number;
    sequentialGroups: number;
    ghostCount: number;
    trapCount: number;
    totalAtRisk: number;
    overallRiskScore: number;
    benfordConformity: string;
    benford2DConformity: string;
    approvalLimitRisk: boolean;
    topRiskAreas: { area: string; severity: "critical" | "high" | "medium"; count: number; message: string }[];
  };
  duplicates: { total: number; pairs: DuplicatePair[] };
  benford1D: { totalTransactions: number; digits: BenfordDigit[]; mad: number; conformity: string; message: string };
  benford2D: { totalTransactions: number; digits: BenfordDigit[]; anomalies: BenfordDigit[]; mad: number; conformity: string };
  thresholdTrap: { total: number; totalAmount: number; byTrap: { trap: string; count: number; amount: number }[]; items: FlaggedDoc[] };
  weekend: { total: number; totalAmount: number; saturday: number; sunday: number; items: FlaggedDoc[] };
  rsf: { total: number; items: (FlaggedDoc & { rsf: number; secondLargest: number; baselineCount: number })[] };
  zscore: { total: number; items: (FlaggedDoc & { zScore: number; vendorAvg: number; vendorStdDev: number; baselineCount: number })[] };
  sequential: SequentialGroup[];
  ghosts: GhostVendor[];
  auditTrail: { total: number; deletes: number; sensitiveChanges: number; events: AuditEvent[] };
  flagged: FlaggedDoc[];
  vendorRisk: { partyId: string | null; partyName: string; flagCount: number; totalAmount: number; flagTypes: string[]; maxRiskScore: number; compositeScore: number }[];
  calendar: { date: string; count: number; amount: number }[];
}

const conformity1D = (mad: number) => (mad <= 0.006 ? "Excellent" : mad <= 0.012 ? "Acceptable" : mad <= 0.015 ? "Marginal" : "Non-Conforming");
const conformity2D = (mad: number) => (mad <= 0.0012 ? "Excellent" : mad <= 0.0022 ? "Acceptable" : mad <= 0.0033 ? "Marginal" : "Non-Conforming");

// ---- main -------------------------------------------------------------------

export async function sentinelData(orgId: string, period: { from: string; to: string; label: string }): Promise<SentinelData> {
  const { from, to } = period;
  const t0 = Date.now();
  const kindsIn = sql.join(SPEND_KINDS.map((k) => sql`${k}`), sql`, `);
  const cfg = await analyticsConfig(orgId, "sentinel");
  const DUPLICATE_THRESHOLD_DAYS = cfg.duplicateDays!;
  const DUPLICATE_MIN_AMOUNT = cfg.duplicateMinAmount!;
  // A duplicate pair must fall within the threshold of each other, so a
  // candidate further outside the window than that can never join to one
  // inside it. Widening the candidate scan by exactly the threshold is
  // equivalent and keeps the self-join off the whole document history.
  // (Computed here rather than as `${from}::date - ${days}` — an untyped bind
  // parameter on the right of a date subtraction does not resolve.)
  const shiftDays = (iso: string, days: number) => {
    const d = new Date(iso + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  const DUPLICATE_SCAN_FROM = shiftDays(from, -DUPLICATE_THRESHOLD_DAYS);
  const DUPLICATE_SCAN_TO = shiftDays(to, DUPLICATE_THRESHOLD_DAYS);
  const SEQUENTIAL_MIN = cfg.sequentialMinCount!;
  const SEQUENTIAL_MIN_DAYS_FOR_FLAG = cfg.sequentialMinDays!;

  // Baseline window for vendor statistics: 36 months before period end.
  const end = new Date(to + "T00:00:00Z");
  const baselineFrom = `${end.getUTCFullYear() - 3}${to.slice(4)}`;

  // Shared filter: non-voided spend documents in the period, |total| ≥ 1.
  const periodDocs = sql`
    from documents d
    where d.org_id = ${orgId} and d.voided_at is null and d.kind in (${kindsIn})
      and coalesce(d.document_date, d.posting_date) >= ${from}
      and coalesce(d.document_date, d.posting_date) <= ${to}
      and abs(coalesce(d.total, 0)) >= 1`;

  const [
    aggRows, trapRows, dupAll, weekendRows,
    vendorStatRows, seqRows, ghostRows, auditRows, auditAgg,
  ] = await Promise.all([
    // Six aggregates — dataset meta, Benford 1D, Benford 2D, the threshold-trap
    // buckets, the weekend split and the calendar heatmap — are the SAME row
    // set grouped six ways. GROUPING SETS computes all six in ONE scan; run as
    // six queries they each re-scanned every spend document in the period and
    // contended for the same buffers. Trap/weekend qualify a subset, so their
    // key is NULL for non-qualifying rows and that null group is dropped below
    // — which reproduces the filter exactly.
    (db.execute(sql`
      with base as (
        select abs(d.total) as amt,
               coalesce(d.document_date, d.posting_date) as ddate,
               left(trunc(abs(d.total))::bigint::text, 1) as digit1,
               case when abs(d.total) >= 10 then left(trunc(abs(d.total))::bigint::text, 2)
                    else left(trunc(abs(d.total) * 10)::bigint::text, 2) end as digit2,
               case when trunc(abs(d.total))::bigint % 100 = 99
                     and round((abs(d.total) - trunc(abs(d.total))) * 100) in (0, 99)
                    then case when trunc(abs(d.total))::bigint % 10000 = 9999 then '9999'
                              when trunc(abs(d.total))::bigint % 1000 = 999 then '999'
                              else '99' end end as trap,
               case when extract(dow from coalesce(d.document_date, d.posting_date)) in (0, 6)
                    then extract(dow from coalesce(d.document_date, d.posting_date))::int end as dow
        ${periodDocs}
      )
      select grouping(digit1) as g_digit1, grouping(digit2) as g_digit2,
             grouping(trap) as g_trap, grouping(dow) as g_dow, grouping(ddate) as g_date,
             digit1, digit2, trap, dow, ddate::text as date,
             count(*) as count, coalesce(sum(amt), 0) as amount
        from base
       group by grouping sets ((), (digit1), (digit2), (trap), (dow), (ddate))
    `)),

    // Threshold trap rows (top by amount) — SQL modular arithmetic, full scan.
    (db.execute(sql`
      select d.id, d.document_number, d.kind, coalesce(d.document_date, d.posting_date)::text as date,
        abs(d.total) as amount, d.party_id, coalesce(p.display_name, '') as party_name,
        case when trunc(abs(d.total))::bigint % 10000 = 9999 then '9999'
             when trunc(abs(d.total))::bigint % 1000 = 999 then '999'
             else '99' end as trap
      from documents d
      left join parties p on p.id = d.party_id and p.org_id = d.org_id
      where d.org_id = ${orgId} and d.voided_at is null and d.kind in (${kindsIn})
        and coalesce(d.document_date, d.posting_date) >= ${from}
        and coalesce(d.document_date, d.posting_date) <= ${to}
        and abs(coalesce(d.total, 0)) >= 1
        and trunc(abs(d.total))::bigint % 100 = 99
        and round((abs(d.total) - trunc(abs(d.total))) * 100) in (0, 99)
      order by abs(d.total) desc
      limit 100
    `)),

    // Duplicates. The candidate set (payable documents above the floor)
    // materializes ONCE, then self hash-joins on the plain CTE columns
    // (party, kind, abs-amount) — equality on materialized columns guarantees
    // a hash plan. The naive documents×documents self-join probed every
    // document's party neighbourhood row-at-a-time (tens of millions of
    // buffer hits on large tenants).
    //
    // The full pair count and the top-200 detail come from ONE statement: the
    // pair set is referenced twice, so Postgres materializes it and the
    // expensive self-join runs once instead of once per result set. The name
    // lookup hangs off the top-200 only, never the whole pair set.
    (db.execute(sql`
      with cand as materialized (
        select id, document_number, kind, party_id, memo, abs(total) as amt,
               coalesce(document_date, posting_date) as ddate
          from documents
         where org_id = ${orgId} and voided_at is null
           and kind in ('vendor_bill', 'check', 'expense_report', 'vendor_payment')
           and party_id is not null
           and abs(coalesce(total, 0)) >= ${DUPLICATE_MIN_AMOUNT}
           and coalesce(document_date, posting_date) >= ${DUPLICATE_SCAN_FROM}
           and coalesce(document_date, posting_date) <= ${DUPLICATE_SCAN_TO}
      ), pairs as (
        select d1.id as id1, d2.id as id2, d1.document_number as num1, d2.document_number as num2,
          d1.kind, d1.ddate as ddate1, d2.ddate as ddate2,
          abs(d2.ddate - d1.ddate) as days_between, d1.amt as amount, d1.party_id,
          (d1.memo is not null and d1.memo = d2.memo) as same_memo
        from cand d1
        join cand d2 on d2.party_id = d1.party_id and d2.kind = d1.kind and d2.amt = d1.amt
          and d1.id < d2.id and abs(d2.ddate - d1.ddate) <= ${DUPLICATE_THRESHOLD_DAYS}
        where (d1.ddate between ${from} and ${to} or d2.ddate between ${from} and ${to})
      ), top as (
        select * from pairs order by amount desc, days_between asc, id1, id2 limit 200
      )
      select 'pair' as src, t.id1, t.id2, t.num1, t.num2, t.kind,
        t.ddate1::text as date1, t.ddate2::text as date2, t.days_between, t.amount,
        t.party_id, coalesce(p.display_name, 'Unknown') as party_name, t.same_memo,
        null::bigint as pair_count
      from top t
      left join parties p on p.id = t.party_id and p.org_id = ${orgId}
      union all
      select 'agg', null::uuid, null::uuid, null::text, null::text, null::text,
        null::text, null::text, null::int, coalesce(sum(amount), 0), null::uuid,
        null::text, null::boolean, count(*)
      from pairs
    `)),

    // Weekend-dated documents (top rows + full aggregate).
    (db.execute(sql`
      select d.id, d.document_number, d.kind, coalesce(d.document_date, d.posting_date)::text as date,
        abs(d.total) as amount, d.party_id, coalesce(p.display_name, '') as party_name,
        extract(dow from coalesce(d.document_date, d.posting_date))::int as dow
      from documents d
      left join parties p on p.id = d.party_id and p.org_id = d.org_id
      where d.org_id = ${orgId} and d.voided_at is null and d.kind in (${kindsIn})
        and coalesce(d.document_date, d.posting_date) >= ${from}
        and coalesce(d.document_date, d.posting_date) <= ${to}
        and abs(coalesce(d.total, 0)) >= 1
        and extract(dow from coalesce(d.document_date, d.posting_date)) in (0, 6)
      order by abs(d.total) desc
      limit 200
    `)),

    // RSF and z-score share ONE per-vendor baseline. Both derive their vendor
    // statistics from the identical 36-month row set, so computing them
    // separately scanned three years of spend documents twice. A single
    // window pass — ordered by amount for the rank, with an explicit full
    // frame so the aggregates still see the whole partition — yields the
    // 2nd-largest, the count, the mean and σ together; the period documents
    // then materialize once and each detector filters them. The two result
    // sets come back unioned with a `src` discriminator and are split below.
    (db.execute(sql`
      with baseline as (
        select d.party_id, abs(d.total) as amount,
          row_number() over w as rn,
          count(*) over w as cnt,
          avg(abs(d.total)) over w as avg_amount,
          stddev_samp(abs(d.total)) over w as std_amount
        from documents d
        where d.org_id = ${orgId} and d.voided_at is null and d.kind in (${kindsIn})
          and d.party_id is not null and abs(coalesce(d.total, 0)) > 0
          and coalesce(d.document_date, d.posting_date) >= ${baselineFrom}
          and coalesce(d.document_date, d.posting_date) <= ${to}
        window w as (partition by d.party_id order by abs(d.total) desc
                     rows between unbounded preceding and unbounded following)
      ), stats as (
        select party_id,
          max(amount) filter (where rn = 2) as second_amount,
          max(cnt) as cnt, max(avg_amount) as avg_amount, max(std_amount) as std_amount
        from baseline group by party_id
      ), period as materialized (
        select d.id, d.document_number, d.kind,
          coalesce(d.document_date, d.posting_date)::text as date,
          abs(d.total) as amount, d.party_id, coalesce(p.display_name, 'Unknown') as party_name
        from documents d
        left join parties p on p.id = d.party_id and p.org_id = d.org_id
        where d.org_id = ${orgId} and d.voided_at is null and d.kind in (${kindsIn})
          and d.party_id is not null
          and coalesce(d.document_date, d.posting_date) >= ${from}
          and coalesce(d.document_date, d.posting_date) <= ${to}
      ), rsf as (
        -- $100 floor: a near-zero historical 2nd-largest turns RSF into noise.
        select pd.*, s.second_amount, s.cnt as baseline_count,
          null::numeric as avg_amount, null::numeric as std_amount,
          pd.amount / s.second_amount as metric
        from period pd
        join stats s on s.party_id = pd.party_id and s.second_amount >= 100
        where pd.amount / s.second_amount >= ${RSF_THRESHOLD}
        order by metric desc
        limit 100
      ), zs as (
        select pd.*, null::numeric as second_amount, s.cnt as baseline_count,
          s.avg_amount, s.std_amount,
          (pd.amount - s.avg_amount) / s.std_amount as metric
        from period pd
        join stats s on s.party_id = pd.party_id and s.cnt >= 5 and s.std_amount > 10
        where abs((pd.amount - s.avg_amount) / s.std_amount) >= ${Z_SCORE_THRESHOLD}
          and abs((pd.amount - s.avg_amount) / s.std_amount) < 50
        order by abs((pd.amount - s.avg_amount) / s.std_amount) desc
        limit 200
      )
      select 'rsf' as src, * from rsf
      union all
      select 'z' as src, * from zs
    `)),

    // Sequential invoice runs — gaps-and-islands over vendor reference numbers.
    (db.execute(sql`
      with refs as (
        select d.id, d.document_number, d.reference_number, d.party_id,
          coalesce(d.document_date, d.posting_date) as doc_date, abs(d.total) as amount,
          (regexp_match(d.reference_number, '([0-9]+)[^0-9]*$'))[1]::numeric as ref_num
        from documents d
        where d.org_id = ${orgId} and d.voided_at is null and d.kind = 'vendor_bill'
          and d.party_id is not null and d.reference_number ~ '[0-9]'
          and coalesce(d.document_date, d.posting_date) >= ${from}
          and coalesce(d.document_date, d.posting_date) <= ${to}
      ), numbered as (
        select *, ref_num - row_number() over (partition by party_id order by ref_num) as island
        from refs
        where ref_num is not null and ref_num <= 9999999
      ), islands as (
        select party_id, island, count(*) as cnt, sum(amount) as total_amount,
          min(ref_num) as start_ref, max(ref_num) as end_ref,
          min(doc_date) as first_date, max(doc_date) as last_date,
          (max(doc_date) - min(doc_date)) as span_days,
          jsonb_agg(jsonb_build_object('docId', id, 'docNumber', document_number, 'reference', reference_number,
            'date', doc_date::text, 'amount', amount) order by ref_num) as invoices
        from numbered
        group by party_id, island
        having count(*) >= ${SEQUENTIAL_MIN} and count(*) = count(distinct ref_num)
      )
      select i.*, coalesce(p.display_name, 'Unknown') as party_name
      from islands i
      left join parties p on p.id = i.party_id and p.org_id = ${orgId}
      where i.span_days >= ${SEQUENTIAL_MIN_DAYS_FOR_FLAG}
      order by i.span_days desc, i.total_amount desc
      limit 50
    `)),

    // Ghost vendors — the full two-phase detector, both phases in SQL.
    // Phase 1: company-vendor names vs employee names. Phase 2: shared street
    // address — line1 normalized (punctuation stripped, directional/street-type
    // words abbreviated) + postal code. Weights as designed: name 75 /
    // address 90 / name+address 95.
    (db.execute(sql`
      with norm_addr as (
        select a.party_id,
          regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
            regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
              regexp_replace(lower(trim(a.line1)), '[^a-z0-9 ]', '', 'g'),
            '\mstreet\M', 'st'), '\mroad\M', 'rd'), '\mavenue\M', 'ave'), '\mdrive\M', 'dr'),
            '\mcourt\M', 'ct'), '\mboulevard\M', 'blvd'), '\mlane\M', 'ln'), '\mplace\M', 'pl'),
            '\mnorth\M', 'n'), '\msouth\M', 's'), '\meast\M', 'e'), '\mwest\M', 'w')
            || '|' || coalesce(regexp_replace(upper(a.postal_code), '\s', '', 'g'), '') as addr_key
        from addresses a
        where a.org_id = ${orgId} and a.line1 is not null and length(trim(a.line1)) >= 5
      )
      select v.id as vendor_id, v.display_name as vendor_name,
        e.id as employee_id, e.display_name as employee_name,
        bool_or(
          length(trim(e.display_name)) >= 7 and (
            upper(trim(v.display_name)) = upper(trim(e.display_name))
            or upper(v.display_name) like '%' || upper(trim(e.display_name)) || '%'
          )
        ) as name_match,
        bool_or(va.addr_key is not null and va.addr_key = ea.addr_key) as address_match
      from parties v
      join parties e on e.org_id = v.org_id and e.kind = 'person' and e.id != v.id and e.is_active
      left join norm_addr va on va.party_id = v.id
      left join norm_addr ea on ea.party_id = e.id
      where v.org_id = ${orgId} and v.kind = 'company' and v.is_active
        and exists (
          select 1 from documents dv
          where dv.org_id = v.org_id and dv.party_id = v.id
            and dv.kind in ('vendor_bill', 'check', 'vendor_payment')
        )
      group by v.id, v.display_name, e.id, e.display_name
      having bool_or(
          length(trim(e.display_name)) >= 7 and (
            upper(trim(v.display_name)) = upper(trim(e.display_name))
            or upper(v.display_name) like '%' || upper(trim(e.display_name)) || '%'
          )
        )
        or bool_or(va.addr_key is not null and va.addr_key = ea.addr_key)
      limit 50
    `)),

    // Native audit trail — deletes + sensitive-field changes on master data.
    (db.execute(sql`
      select a.id, a.table_name, a.row_id::text as row_id, a.action, a.actor_id::text as actor_id, a.at::text as at,
        left(coalesce(a.changes::text, ''), 200) as changes
      from audit_log a
      where a.org_id = ${orgId}
        and a.at >= ${from}::date and a.at < (${to}::date + interval '1 day')
        and (
          a.action in ('delete', 'DELETE')
          or a.table_name in ('parties', 'bank_accounts')
          or a.changes::text ~* 'bank|routing|iban|account_number|email|address'
        )
      order by a.at desc
      limit 100
    `)),
    (db.execute(sql`
      select count(*) as total,
        count(*) filter (where action in ('delete', 'DELETE')) as deletes,
        count(*) filter (where changes::text ~* 'bank|routing|iban|account_number|email|address') as sensitive
      from audit_log
      where org_id = ${orgId} and at >= ${from}::date and at < (${to}::date + interval '1 day')
    `)),

  ]);

  // Split the one grouping-sets result back into the six aggregate shapes.
  // grouping(col) is 0 exactly when that column is a real key for the row, so
  // each set is picked out by its own flag; the null key in the trap/weekend
  // sets is the non-qualifying remainder and is dropped.
  const dupAllRows = (dupAll.rows);
  const dupRows = { rows: dupAllRows.filter((r) => r.src === "pair") };
  const dupAgg = { rows: dupAllRows.filter((r) => r.src === "agg").map((r) => ({ total: r.pair_count, amount: r.amount })) };

  const vendorStats = (vendorStatRows.rows);
  const rsfRows = { rows: vendorStats.filter((r) => r.src === "rsf").map((r) => ({ ...r, rsf: r.metric })) };
  const zRows = { rows: vendorStats.filter((r) => r.src === "z").map((r) => ({ ...r, z: r.metric })) };

  const aggAll = aggRows.rows as AggregateRow[];
  const gset = (flag: string, key: string) =>
    aggAll.filter((r) => Number(r[flag]) === 0 && r[key] !== null);
  const metaRows = {
    // The grand-total set: every flag 1, i.e. nothing is a group key.
    rows: aggAll
      .filter((r) => ["g_digit1", "g_digit2", "g_trap", "g_dow", "g_date"].every((f) => Number(r[f]) === 1))
      .map((r) => ({ docs: r.count, amount: r.amount })),
  };
  const b1Rows = { rows: gset("g_digit1", "digit1").map((r) => ({ digit: r.digit1, count: r.count, amount: r.amount })) };
  const b2Rows = { rows: gset("g_digit2", "digit2").map((r) => ({ digits: r.digit2, count: r.count, amount: r.amount })) };
  const trapAgg = { rows: gset("g_trap", "trap") };
  const weekendAgg = { rows: gset("g_dow", "dow") };
  const calRows = {
    rows: gset("g_date", "date").sort((a, b) => String(a.date).localeCompare(String(b.date))),
  };

  // ---- Benford 1D --------------------------------------------------------------
  const b1Map = new Map<string, { count: number; amount: number }>(
    ((b1Rows.rows)).map((r) => [String(r.digit), { count: Number(r.count), amount: Number(r.amount) }]),
  );
  const total1D = [...b1Map.values()].reduce((s, v) => s + v.count, 0);
  let sumAbsDev1 = 0;
  const digits1D: BenfordDigit[] = [];
  for (let d = 1; d <= 9; d++) {
    const row = b1Map.get(String(d));
    const observed = row && total1D > 0 ? row.count / total1D : 0;
    const expected = BENFORD_1D[d]!;
    const deviation = observed - expected;
    sumAbsDev1 += Math.abs(deviation);
    digits1D.push({
      digit: d, count: row?.count ?? 0, amount: row?.amount ?? 0,
      observed, expected, deviationPct: expected > 0 ? (deviation / expected) * 100 : 0,
      isAnomaly: Math.abs(expected > 0 ? (deviation / expected) * 100 : 0) > 25,
    });
  }
  const mad1D = sumAbsDev1 / 9;
  const benfordMessage =
    total1D < 50
      ? `Insufficient data (${total1D} transactions). Need at least 50.`
      : mad1D <= 0.006
        ? "Transaction amounts closely follow Benford's Law — low manipulation risk."
        : mad1D <= 0.012
          ? "Transaction amounts reasonably follow Benford's Law."
          : mad1D <= 0.015
            ? "Some deviation detected — warrants review."
            : "Significant deviation — possible manipulation.";

  // ---- Benford 2D --------------------------------------------------------------
  const b2Map = new Map<string, { count: number; amount: number }>(
    ((b2Rows.rows)).map((r) => [String(r.digits), { count: Number(r.count), amount: Number(r.amount) }]),
  );
  const total2D = [...b2Map.values()].reduce((s, v) => s + v.count, 0);
  let sumAbsDev2 = 0;
  const digits2D: BenfordDigit[] = [];
  for (let d = 10; d <= 99; d++) {
    const row = b2Map.get(String(d));
    const observed = row && total2D > 0 ? row.count / total2D : 0;
    const expected = Math.log10(1 + 1 / d);
    const deviation = observed - expected;
    sumAbsDev2 += Math.abs(deviation);
    const deviationPct = expected > 0 ? (deviation / expected) * 100 : 0;
    digits2D.push({ digit: d, count: row?.count ?? 0, amount: row?.amount ?? 0, observed, expected, deviationPct, isAnomaly: Math.abs(deviationPct) > 50 });
  }
  const mad2D = sumAbsDev2 / 90;
  const anomalies2D = digits2D.filter((x) => x.isAnomaly && x.count >= 5).sort((a, b) => Math.abs(b.deviationPct) - Math.abs(a.deviationPct));

  // ---- Threshold trap ------------------------------------------------------------
  const trapItems: FlaggedDoc[] = (trapRows.rows as FlaggedDocumentRow[]).map((r) => ({
    docId: r.id, docNumber: r.document_number ?? "", kind: r.kind, date: r.date,
    amount: Number(r.amount), partyId: r.party_id, partyName: r.party_name ?? "",
    flagType: "trap" as const,
    reason: `Amount ends in ${r.trap} (potential threshold avoidance)`,
    riskScore: r.trap === "9999" ? 65 : r.trap === "999" ? 55 : 45,
  }));
  const trapByTrap = ((trapAgg.rows)).map((r) => ({ trap: r.trap as string, count: Number(r.count), amount: Number(r.amount) }));
  const trapTotal = trapByTrap.reduce((s, t) => s + t.count, 0);

  // ---- Duplicates ------------------------------------------------------------------
  const dupPairs: DuplicatePair[] = (dupRows.rows as DuplicateRow[]).map((r) => {
    const amount = Number(r.amount);
    const days = Number(r.days_between);
    const sameMemo = Boolean(r.same_memo);
    let score = 50;
    if (amount >= CRITICAL_RISK_AMOUNT) score += 25;
    else if (amount >= HIGH_RISK_AMOUNT) score += 15;
    else if (amount >= 1000) score += 5;
    if (days <= 1) score += 20;
    else if (days <= 3) score += 15;
    else if (days <= 7) score += 10;
    if (sameMemo) score += 10;
    return {
      docId1: r.id1, docId2: r.id2, docNumber1: r.num1 ?? "", docNumber2: r.num2 ?? "",
      kind: r.kind, date1: r.date1, date2: r.date2, daysBetween: days, amount,
      partyId: r.party_id, partyName: r.party_name,
      sameMemo,
      confidence: sameMemo ? 0.95 : days <= 3 ? 0.9 : days <= 7 ? 0.85 : 0.75,
      riskScore: Math.min(100, score),
    };
  });
  const dupTotal = Number(dupAgg.rows[0]?.total ?? 0);
  const dupAmount = Number(dupAgg.rows[0]?.amount ?? 0);

  // ---- Weekend ------------------------------------------------------------------------
  const weekendItems: FlaggedDoc[] = (weekendRows.rows as FlaggedDocumentRow[]).map((r) => {
    const amount = Number(r.amount);
    const isSunday = Number(r.dow) === 0;
    let score = 35;
    if (amount >= CRITICAL_RISK_AMOUNT) score += 30;
    else if (amount >= HIGH_RISK_AMOUNT) score += 20;
    if (isSunday) score += 10;
    return {
      docId: r.id, docNumber: r.document_number ?? "", kind: r.kind, date: r.date,
      amount, partyId: r.party_id, partyName: r.party_name ?? "",
      flagType: "weekend" as const,
      reason: `Dated on ${isSunday ? "Sunday" : "Saturday"}`,
      riskScore: Math.min(100, score),
    };
  });
  let satCount = 0, sunCount = 0, weekendAmount = 0;
  for (const r of (weekendAgg.rows)) {
    if (Number(r.dow) === 0) sunCount = Number(r.count);
    else satCount = Number(r.count);
    weekendAmount += Number(r.amount);
  }
  const weekendTotal = satCount + sunCount;

  // ---- RSF ------------------------------------------------------------------------------
  const rsfItems = (rsfRows.rows as VendorStatisticRow[]).map((r) => {
    const rsf = Number(r.rsf);
    const amount = Number(r.amount);
    let score = 40;
    if (rsf >= 50) score += 40; else if (rsf >= 20) score += 30; else if (rsf >= 15) score += 20; else score += 10;
    if (amount >= CRITICAL_RISK_AMOUNT) score += 15; else if (amount >= HIGH_RISK_AMOUNT) score += 10;
    return {
      docId: r.id, docNumber: r.document_number ?? "", kind: r.kind, date: r.date,
      amount, partyId: r.party_id, partyName: r.party_name ?? "",
      flagType: "rsf" as const,
      reason: `${rsf.toFixed(1)}× larger than ${r.party_name}'s historical 2nd largest`,
      riskScore: Math.min(100, score),
      rsf, secondLargest: Number(r.second_amount), baselineCount: Number(r.baseline_count),
    };
  });

  // ---- Z-score ------------------------------------------------------------------------------
  const zItems = (zRows.rows as VendorStatisticRow[]).map((r) => {
    const z = Number(r.z);
    const amount = Number(r.amount);
    let score = 45;
    if (Math.abs(z) >= 5) score += 30; else if (Math.abs(z) >= 4) score += 20;
    if (amount >= CRITICAL_RISK_AMOUNT) score += 15;
    return {
      docId: r.id, docNumber: r.document_number ?? "", kind: r.kind, date: r.date,
      amount, partyId: r.party_id, partyName: r.party_name ?? "",
      flagType: "zscore" as const,
      reason: `Z-score ${Math.abs(z).toFixed(2)} vs ${r.party_name} average (${r.baseline_count} txns)`,
      riskScore: Math.min(100, score),
      zScore: z, vendorAvg: Number(r.avg_amount), vendorStdDev: Number(r.std_amount), baselineCount: Number(r.baseline_count),
    };
  });

  // ---- Sequential runs -----------------------------------------------------------------------
  const sequential: SequentialGroup[] = (seqRows.rows as SequentialRow[]).map((r) => {
    const spanDays = Number(r.span_days);
    const count = Number(r.cnt);
    const totalAmount = Number(r.total_amount);
    let score = spanDays >= SEQUENTIAL_HIGH_RISK_DAYS ? 75 : 50;
    score += Math.min(count * 4, 20);
    if (totalAmount > 100_000) score += 10; else if (totalAmount > 50_000) score += 7; else if (totalAmount > 25_000) score += 5;
    const level: "high" | "medium" = spanDays >= SEQUENTIAL_HIGH_RISK_DAYS ? "high" : "medium";
    return {
      partyId: r.party_id, partyName: r.party_name, count, totalAmount,
      startRef: Number(r.start_ref), endRef: Number(r.end_ref), dateSpanDays: spanDays,
      firstDate: String(r.first_date), lastDate: String(r.last_date),
      riskLevel: level, riskScore: Math.min(100, score),
      reason: `${count} gap-free sequential invoices (${r.start_ref}–${r.end_ref}) over ${spanDays} days${level === "high" ? " — possible shell company / sole customer" : ""}`,
      invoices: ((r.invoices)).slice(0, 12),
    };
  });

  // ---- Ghost vendors (Score tiers: name 75 / address 90 / name+address 95) -----------------------
  const ghosts: GhostVendor[] = (ghostRows.rows as GhostRow[]).map((r) => {
    const name = Boolean(r.name_match);
    const addr = Boolean(r.address_match);
    const matchType: GhostVendor["matchType"] = name && addr ? "name+address" : addr ? "address" : "name";
    return {
      vendorId: r.vendor_id, vendorName: r.vendor_name, employeeId: r.employee_id, employeeName: r.employee_name,
      matchType,
      riskScore: name && addr ? 95 : addr ? 90 : 75,
      reason: name && addr
        ? `Vendor "${r.vendor_name}" matches employee "${r.employee_name}" by BOTH name and street address`
        : addr
          ? `Vendor "${r.vendor_name}" shares a street address with employee "${r.employee_name}"`
          : `Vendor "${r.vendor_name}" matches employee name "${r.employee_name}"`,
    };
  }).sort((a, b) => b.riskScore - a.riskScore);

  // ---- Audit trail ---------------------------------------------------------------------------------
  const auditEvents: AuditEvent[] = (auditRows.rows as AuditRow[]).map((r) => ({
    id: r.id, tableName: r.table_name, rowId: r.row_id, action: r.action, actorId: r.actor_id, at: r.at,
    summary: r.changes || "",
  }));
  const auditTotal = Number(auditAgg.rows[0]?.total ?? 0);
  const auditDeletes = Number(auditAgg.rows[0]?.deletes ?? 0);
  const auditSensitive = Number(auditAgg.rows[0]?.sensitive ?? 0);

  // ---- Flagged aggregate (dedup by doc, stable order) -----------------------------------------------
  const flagged: FlaggedDoc[] = [];
  const seen = new Set<string>();
  const push = (f: FlaggedDoc) => { if (!seen.has(f.docId)) { seen.add(f.docId); flagged.push(f); } };
  for (const d of dupPairs) {
    // The pair scan includes the threshold-sized boundary on both sides of
    // the report period. Keep the flagged aggregate anchored to whichever
    // member is actually in-period when the older/lower-ID member is outside.
    const firstInPeriod = d.date1 >= from && d.date1 <= to;
    push({
      docId: firstInPeriod ? d.docId1 : d.docId2,
      docNumber: firstInPeriod ? d.docNumber1 : d.docNumber2,
      kind: d.kind,
      date: firstInPeriod ? d.date1 : d.date2,
      amount: d.amount,
      partyId: d.partyId,
      partyName: d.partyName,
      flagType: "duplicate",
      reason: `Same vendor, kind & amount as ${(firstInPeriod ? d.docNumber2 : d.docNumber1) || "pair"} (${d.daysBetween}d apart)`,
      riskScore: d.riskScore,
    });
  }
  for (const w of weekendItems) push(w);
  for (const r of rsfItems) push(r);
  for (const z of zItems) push(z);
  // Composite signal: duplicates + weekend + RSF + z-score + sequential-run
  // invoices (threshold-trap docs stay in their own tab, NOT in the aggregate).
  for (const s of sequential)
    for (const inv of s.invoices)
      push({ docId: inv.docId, docNumber: inv.docNumber, kind: "vendor_bill", date: inv.date, amount: inv.amount, partyId: s.partyId, partyName: s.partyName, flagType: "sequential", reason: s.reason, riskScore: s.riskScore });
  flagged.sort((a, b) => b.riskScore - a.riskScore);

  // ---- Vendor risk roll-up ---------------------------------------------------------------------------
  const vendorMap = new Map<string, SentinelData["vendorRisk"][number]>();
  for (const f of flagged) {
    const key = f.partyId ?? f.partyName ?? "unknown";
    let v = vendorMap.get(key);
    if (!v) { v = { partyId: f.partyId, partyName: f.partyName || "Unknown", flagCount: 0, totalAmount: 0, flagTypes: [], maxRiskScore: 0, compositeScore: 0 }; vendorMap.set(key, v); }
    v.flagCount++;
    v.totalAmount += Math.abs(f.amount);
    v.maxRiskScore = Math.max(v.maxRiskScore, f.riskScore);
    if (!v.flagTypes.includes(f.flagType)) v.flagTypes.push(f.flagType);
  }
  // Composite vendor score: flag volume (cap 40) + amount tier + flag-type
  // diversity + 30% of the worst single flag, capped at 100. Sorted by it.
  for (const v of vendorMap.values()) {
    const amountTier = v.totalAmount >= 50_000 ? 25 : v.totalAmount >= 10_000 ? 15 : 5;
    v.compositeScore = Math.min(100, Math.round(Math.min(v.flagCount * 8, 40) + amountTier + v.flagTypes.length * 8 + v.maxRiskScore * 0.3));
  }
  const vendorRisk = [...vendorMap.values()].sort((a, b) => b.compositeScore - a.compositeScore || b.totalAmount - a.totalAmount).slice(0, 50);

  // ---- Summary (stable risk model) ------------------------------------------------------------
  let risk = 0;
  if (flagged.length > 50) risk += 15; else if (flagged.length > 20) risk += 10;
  if (dupAmount > 100_000) risk += 20; else if (dupAmount > 50_000) risk += 15;
  if (ghosts.length > 0) risk += 25;
  if (sequential.length > 0) risk += 15;
  if (conformity1D(mad1D) === "Non-Conforming") risk += 15;

  const topRiskAreas: SentinelData["summary"]["topRiskAreas"] = [];
  if (ghosts.length) topRiskAreas.push({ area: "Ghost Vendors", severity: "critical", count: ghosts.length, message: `${ghosts.length} vendor(s) match employee names` });
  if (sequential.length) topRiskAreas.push({ area: "Sequential Invoices", severity: "high", count: sequential.length, message: `${sequential.length} vendor(s) with gap-free invoice runs` });
  if (dupTotal > 10) topRiskAreas.push({ area: "Duplicate Payments", severity: "high", count: dupTotal, message: `${dupTotal} potential duplicate pairs` });
  if (trapTotal > 0) topRiskAreas.push({ area: "Approval Limit Avoidance", severity: "high", count: trapTotal, message: `${trapTotal} amounts ending 99/999/9999` });
  if (conformity1D(mad1D) === "Non-Conforming") topRiskAreas.push({ area: "Benford Deviation", severity: "medium", count: total1D, message: "First-digit distribution deviates significantly" });
  topRiskAreas.sort((a, b) => ({ critical: 0, high: 1, medium: 2 }[a.severity] - { critical: 0, high: 1, medium: 2 }[b.severity]));

  const meta = metaRows.rows[0] ?? { docs: 0, amount: 0 };
  const days = Math.round((end.getTime() - new Date(from + "T00:00:00Z").getTime()) / 86_400_000) + 1;

  return {
    period,
    meta: { totalDocs: Number(meta.docs ?? 0), totalAmount: Number(meta.amount ?? 0), days, queryMs: Date.now() - t0 },
    config: cfg,
    summary: {
      flaggedCount: flagged.length,
      duplicateCount: dupTotal,
      totalDuplicateAmount: dupAmount,
      weekendCount: weekendTotal,
      weekendAmount,
      rsfCount: rsfItems.length,
      zScoreCount: zItems.length,
      sequentialGroups: sequential.length,
      ghostCount: ghosts.length,
      trapCount: trapTotal,
      totalAtRisk: flagged.reduce((s, f) => s + Math.abs(f.amount), 0),
      overallRiskScore: Math.min(100, risk),
      benfordConformity: conformity1D(mad1D),
      benford2DConformity: conformity2D(mad2D),
      approvalLimitRisk: trapTotal > 0,
      topRiskAreas,
    },
    duplicates: { total: dupTotal, pairs: dupPairs },
    benford1D: { totalTransactions: total1D, digits: digits1D, mad: mad1D, conformity: conformity1D(mad1D), message: benfordMessage },
    benford2D: { totalTransactions: total2D, digits: digits2D, anomalies: anomalies2D, mad: mad2D, conformity: conformity2D(mad2D) },
    thresholdTrap: { total: trapTotal, totalAmount: trapByTrap.reduce((s, t) => s + t.amount, 0), byTrap: trapByTrap, items: trapItems },
    weekend: { total: weekendTotal, totalAmount: weekendAmount, saturday: satCount, sunday: sunCount, items: weekendItems },
    rsf: { total: rsfItems.length, items: rsfItems },
    zscore: { total: zItems.length, items: zItems },
    sequential,
    ghosts,
    auditTrail: { total: auditTotal, deletes: auditDeletes, sensitiveChanges: auditSensitive, events: auditEvents },
    flagged: flagged.slice(0, 300),
    vendorRisk,
    calendar: ((calRows.rows)).map((r) => ({ date: String(r.date), count: Number(r.count), amount: Number(r.amount) })),
  };
}

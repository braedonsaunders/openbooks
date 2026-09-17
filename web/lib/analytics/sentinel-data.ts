import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { addMonthsIso } from "@openbooks/reports";
import { analyticsConfig } from "./config";
import { presentationCurrency } from "../fx-presentation";
import { can, ForbiddenError, type Authz } from "../authz";
import { auditEventArgs, englishSentinelStrings, type ConformityCode, type SentinelStrings } from "./sentinel-strings";

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
 *  - Duplicates: natural-key groups — same vendor + doc kind + document
 *    currency + amount + vendor reference, with the date span inside the
 *    duplicate window (≥$100, credits excluded); ONE finding per group with
 *    every member document listed. Confidence by reference/date proximity.
 *  - Benford first-digit + first-two-digit distributions with Mean Absolute
 *    Deviation conformity bands (Nigrini), computed PER DOCUMENT CURRENCY —
 *    never on translated or blended amounts.
 *  - Threshold trap: amounts ending 99 / 999 / 9999 (approval-limit gaming).
 *    Stays transaction-denominated by design: 99-endings are
 *    currency-specific commercial psychology, so detection reads the
 *    document amount, never a translation.
 *  - Weekend documents: spend documents dated Saturday or Sunday, using the
 *    accounting date rather than an import timestamp.
 *  - RSF: amount ÷ vendor's historical 2nd-largest (36-month baseline,
 *    same document currency) ≥ 10.
 *  - Z-score: |amount − vendor mean| / vendor σ ≥ 3 (same-currency baseline
 *    ≥ 5 txns, σ>10).
 *  - Sequential invoices: gap-free vendor reference-number runs per
 *    (vendor, currency) spread over 7+ days — the shell-company /
 *    sole-customer indicator.
 *
 * Currency basis (owner decision): every statistical test runs per document
 * currency. Consolidated MONEY columns (meta, summary, calendar, vendor
 * roll-up, trap/weekend/sequential totals, duplicate value at risk) translate
 * each document at its own document FX (round(|total| × fx_rate, 4) — ledger
 * precision) into the org base. Multi-functional orgs therefore read an
 * approximation: the UI labels the basis wherever a translated figure shows.
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
  /** Document (transaction) currency — detection evidence stays denominated. */
  currency: string;
  /** Translated at the document's own FX for consolidated display. */
  funcAmount: number;
  partyId: string | null;
  partyName: string;
  flagType: "duplicate" | "weekend" | "rsf" | "zscore" | "trap" | "sequential";
  reason: string;
  riskScore: number;
}

export interface DuplicateMember {
  docId: string; docNumber: string; reference: string; date: string;
  amount: number; currency: string; funcAmount: number; memo: string | null;
}

/** ONE finding per natural-key group: (party, kind, currency, amount, reference). */
export interface DuplicateGroup {
  groupId: string;
  partyId: string | null; partyName: string;
  kind: string; currency: string;
  amount: number; funcTotal: number;
  count: number; dateSpanDays: number; firstDate: string; lastDate: string;
  sameReference: boolean; confidence: number; riskScore: number;
  members: DuplicateMember[];
}

export interface DuplicatePair {
  docId1: string; docId2: string; docNumber1: string; docNumber2: string;
  kind: string; date1: string; date2: string; daysBetween: number;
  amount: number; currency: string; partyId: string | null; partyName: string;
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
  currency: string;
  startRef: number; endRef: number; dateSpanDays: number;
  firstDate: string; lastDate: string;
  riskLevel: "high" | "medium"; riskScore: number; reason: string;
  invoices: { docId: string; docNumber: string; reference: string; date: string; amount: number; currency: string; funcAmount: number }[];
}

/** One Benford distribution for a single document currency. */
export interface BenfordCurrencySlice {
  currency: string;
  totalTransactions: number;
  digits: BenfordDigit[];
  mad: number;
  conformity: string;
  message: string;
  anomalies: BenfordDigit[];
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
  currency: string; func_amount: string | number;
  party_id: string | null; party_name: string | null; trap?: string; dow?: string | number;
}
/** One natural-key group row with its member documents as JSON. */
interface DuplicateGroupRow extends Record<string, unknown> {
  party_id: string | null; party_name: string; kind: string; currency: string;
  amt: string | number; refkey: string; cnt: string | number;
  first_date: string; last_date: string; span_days: string | number;
  func_total: string | number; value_at_risk: string | number;
  members: Array<{
    docId: string; docNumber: string | null; reference: string; date: string;
    amount: string | number; currency: string; funcAmount: string | number; memo: string | null;
  }>;
}
interface VendorStatisticRow extends FlaggedDocumentRow {
  rsf?: string | number; z?: string | number; second_amount: string | number;
  baseline_count: string | number; avg_amount: string | number; std_amount: string | number;
}
interface SequentialRow extends Record<string, unknown> {
  party_id: string; party_name: string; span_days: string | number; cnt: string | number;
  total_amount: string | number; currency: string;
  start_ref: string | number; end_ref: string | number;
  first_date: string; last_date: string;
  invoices: Array<{ docId: string; docNumber: string; reference: string; date: string; amount: number; currency: string; funcAmount: number }>;
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
  meta: { totalDocs: number; totalAmount: number; presentationCurrency: string; days: number; queryMs: number };
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
  duplicates: { total: number; pairs: DuplicatePair[]; groups: DuplicateGroup[] };
  benford1D: { totalTransactions: number; digits: BenfordDigit[]; mad: number; conformity: string; message: string; byCurrency: BenfordCurrencySlice[] };
  benford2D: { totalTransactions: number; digits: BenfordDigit[]; anomalies: BenfordDigit[]; mad: number; conformity: string; byCurrency: BenfordCurrencySlice[] };
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

/**
 * Benford conformity as a stable code — never translated text, so forensic
 * payloads (and the client's severity switches) compare against the same
 * value in every language. The request-scoped dashboard maps codes to words.
 */
const conformity1D = (mad: number): ConformityCode =>
  (mad <= 0.006 ? "excellent" : mad <= 0.012 ? "acceptable" : mad <= 0.015 ? "marginal" : "nonConforming");
const conformity2D = (mad: number): ConformityCode =>
  (mad <= 0.0012 ? "excellent" : mad <= 0.0022 ? "acceptable" : mad <= 0.0033 ? "marginal" : "nonConforming");

/** Return the inclusive start of the 36-month vendor-statistics baseline. */
export function sentinelBaselineFrom(to: string): string {
  return addMonthsIso(to, -36);
}

// ---- main -------------------------------------------------------------------

export async function sentinelData(
  orgId: string,
  period: { from: string; to: string; label: string },
  authz: Authz,
  strings: SentinelStrings = englishSentinelStrings,
): Promise<SentinelData> {
  // Whole-company forensics includes cross-entity baselines, identity matches
  // and retained administrative audit snapshots. Partial access cannot be
  // represented by silently dropping evidence or returning zero-risk counts.
  if (!authz || authz.user.orgId !== orgId || authz.allowedSubsidiaryIds !== null
    || !can(authz, "reports.read") || !can(authz, "admin.audit.read")) {
    throw new ForbiddenError("unrestricted reports and audit access");
  }
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
  const baselineFrom = sentinelBaselineFrom(to);
  // Consolidated money label: the org base the document-FX translations land in.
  const presentationCcy = await presentationCurrency(orgId);

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
    // Six aggregates — dataset meta, per-currency Benford 1D, per-currency
    // Benford 2D, the threshold-trap buckets, the weekend split and the
    // calendar heatmap — are the SAME row set grouped six ways. GROUPING SETS
    // computes all six in ONE scan; run as six queries they each re-scanned
    // every spend document in the period and contended for the same buffers.
    // Trap/weekend qualify a subset, so their key is NULL for non-qualifying
    // rows and that null group is dropped below — which reproduces the filter
    // exactly. Benford sets carry the document currency (one distribution per
    // currency, never blended); every money sum is the document-FX
    // translation (ledger precision), while digit/trap detection reads the
    // transaction amount.
    (db.execute(sql`
      with base as (
        select d.currency as cur,
               abs(d.total) as txn_amt,
               round(abs(d.total) * d.fx_rate, 4) as func_amt,
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
      select grouping(cur) as g_cur,
             grouping(digit1) as g_digit1, grouping(digit2) as g_digit2,
             grouping(trap) as g_trap, grouping(dow) as g_dow, grouping(ddate) as g_date,
             cur, digit1, digit2, trap, dow, ddate::text as date,
             count(*) as count, coalesce(sum(func_amt), 0) as amount
        from base
       group by grouping sets ((), (cur, digit1), (cur, digit2), (trap), (dow), (ddate))
    `)),

    // Threshold trap rows (top by amount) — SQL modular arithmetic, full scan.
    // Detection reads the transaction amount (currency-specific psychology);
    // the row also carries its document-FX translation for consolidated sums.
    (db.execute(sql`
      select d.id, d.document_number, d.kind, coalesce(d.document_date, d.posting_date)::text as date,
        abs(d.total) as amount, d.currency as currency, round(abs(d.total) * d.fx_rate, 4) as func_amount,
        d.party_id, coalesce(p.display_name, '') as party_name,
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
    // materializes ONCE, then groups by the natural key — party, kind,
    // document currency, abs-amount and normalized vendor reference — keeping
    // only groups of 2+ whose date span fits the duplicate window. Currency
    // in the key kills the cross-currency false positive (a USD 100 bill is
    // not a copy of a CAD 100 bill); the reference in the key keeps recurring
    // same-amount invoices with distinct references out. Each group reports
    // ONE finding with every member listed; the value at risk is every copy
    // beyond the largest presumed-legitimate original, translated at
    // document FX. The group count and the value at risk come from ONE
    // statement: the qualified set is referenced twice, so Postgres
    // materializes it and the grouping runs once. The name lookup hangs off
    // the top groups only, never the whole set.
    (db.execute(sql`
      with cand as materialized (
        select id, document_number, kind, party_id, memo, reference_number, currency, fx_rate,
               abs(total) as amt, round(abs(total) * fx_rate, 4) as func_amt,
               coalesce(document_date, posting_date) as ddate
          from documents
         where org_id = ${orgId} and voided_at is null
           and kind in ('vendor_bill', 'check', 'expense_report', 'vendor_payment')
           and party_id is not null
           and abs(coalesce(total, 0)) >= ${DUPLICATE_MIN_AMOUNT}
           and coalesce(document_date, posting_date) >= ${DUPLICATE_SCAN_FROM}
           and coalesce(document_date, posting_date) <= ${DUPLICATE_SCAN_TO}
      ), keyed as (
        select *, lower(trim(coalesce(reference_number, ''))) as refkey from cand
      ), grouped as (
        select party_id, kind, currency, amt, refkey,
          count(*) as cnt, min(ddate) as first_date, max(ddate) as last_date,
          (max(ddate) - min(ddate)) as span_days,
          coalesce(sum(func_amt), 0) as func_total,
          coalesce(sum(func_amt), 0) - max(func_amt) as value_at_risk,
          jsonb_agg(jsonb_build_object('docId', id, 'docNumber', document_number,
            'reference', coalesce(reference_number, ''), 'date', ddate::text,
            'amount', amt, 'currency', currency, 'funcAmount', func_amt,
            'memo', memo) order by ddate, id) as members
        from keyed
        group by party_id, kind, currency, amt, refkey
        having count(*) >= 2 and (max(ddate) - min(ddate)) <= ${DUPLICATE_THRESHOLD_DAYS}
      ), qualified as (
        select * from grouped
        where (first_date between ${from} and ${to} or last_date between ${from} and ${to})
      ), top as (
        select * from qualified order by func_total desc, span_days asc, party_id, kind, currency, amt, refkey limit 50
      )
      select 'group' as src, t.party_id, coalesce(p.display_name, 'Unknown') as party_name,
        t.kind, t.currency, t.amt, t.refkey, t.cnt, t.first_date::text as first_date,
        t.last_date::text as last_date, t.span_days, t.func_total, t.value_at_risk, t.members,
        null::bigint as group_count
      from top t
      left join parties p on p.id = t.party_id and p.org_id = ${orgId}
      union all
      select 'agg', null::uuid, null::text, null::text, null::text, null::numeric, null::text,
        null::int, null::text, null::text, null::int, null::numeric, coalesce(sum(value_at_risk), 0),
        null::jsonb, count(*)
      from qualified
    `)),

    // Weekend-dated documents (top rows + full aggregate).
    (db.execute(sql`
      select d.id, d.document_number, d.kind, coalesce(d.document_date, d.posting_date)::text as date,
        abs(d.total) as amount, d.currency as currency, round(abs(d.total) * d.fx_rate, 4) as func_amount,
        d.party_id, coalesce(p.display_name, '') as party_name,
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

    // RSF and z-score share ONE per-(vendor, currency) baseline. Both derive
    // their statistics from the identical 36-month row set, so computing them
    // separately scanned three years of spend documents twice. A single
    // window pass — ordered by amount for the rank, with an explicit full
    // frame so the aggregates still see the whole partition — yields the
    // 2nd-largest, the count, the mean and σ together; the period documents
    // then materialize once and each detector filters them. Partitioning by
    // currency keeps a foreign-currency bill out of the baseline: it can
    // neither false-flag against another currency's history nor inflate σ
    // and mask a genuine same-currency outlier. The two result sets come back
    // unioned with a `src` discriminator and are split below.
    (db.execute(sql`
      with baseline as (
        select d.party_id, d.currency, abs(d.total) as amount,
          row_number() over w as rn,
          count(*) over w as cnt,
          avg(abs(d.total)) over w as avg_amount,
          stddev_samp(abs(d.total)) over w as std_amount
        from documents d
        where d.org_id = ${orgId} and d.voided_at is null and d.kind in (${kindsIn})
          and d.party_id is not null and abs(coalesce(d.total, 0)) > 0
          and coalesce(d.document_date, d.posting_date) >= ${baselineFrom}
          and coalesce(d.document_date, d.posting_date) <= ${to}
        window w as (partition by d.party_id, d.currency order by abs(d.total) desc
                     rows between unbounded preceding and unbounded following)
      ), stats as (
        select party_id, currency,
          max(amount) filter (where rn = 2) as second_amount,
          max(cnt) as cnt, max(avg_amount) as avg_amount, max(std_amount) as std_amount
        from baseline group by party_id, currency
      ), period as materialized (
        select d.id, d.document_number, d.kind,
          coalesce(d.document_date, d.posting_date)::text as date,
          abs(d.total) as amount, d.currency as currency,
          round(abs(d.total) * d.fx_rate, 4) as func_amount,
          d.party_id, coalesce(p.display_name, 'Unknown') as party_name
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
        join stats s on s.party_id = pd.party_id and s.currency = pd.currency and s.second_amount >= 100
        where pd.amount / s.second_amount >= ${RSF_THRESHOLD}
        order by metric desc
        limit 100
      ), zs as (
        select pd.*, null::numeric as second_amount, s.cnt as baseline_count,
          s.avg_amount, s.std_amount,
          (pd.amount - s.avg_amount) / s.std_amount as metric
        from period pd
        join stats s on s.party_id = pd.party_id and s.currency = pd.currency and s.cnt >= 5 and s.std_amount > 10
        where abs((pd.amount - s.avg_amount) / s.std_amount) >= ${Z_SCORE_THRESHOLD}
          and abs((pd.amount - s.avg_amount) / s.std_amount) < 50
        order by abs((pd.amount - s.avg_amount) / s.std_amount) desc
        limit 200
      )
      select 'rsf' as src, * from rsf
      union all
      select 'z' as src, * from zs
    `)),

    // Sequential invoice runs — gaps-and-islands over vendor reference numbers,
    // one island space per (vendor, document currency): a run is only a run
    // in a single currency. Money totals translate at document FX.
    (db.execute(sql`
      with refs as (
        select d.id, d.document_number, d.reference_number, d.party_id, d.currency,
          coalesce(d.document_date, d.posting_date) as doc_date, abs(d.total) as amount,
          round(abs(d.total) * d.fx_rate, 4) as func_amount,
          (regexp_match(d.reference_number, '([0-9]+)[^0-9]*$'))[1]::numeric as ref_num
        from documents d
        where d.org_id = ${orgId} and d.voided_at is null and d.kind = 'vendor_bill'
          and d.party_id is not null and d.reference_number ~ '[0-9]'
          and coalesce(d.document_date, d.posting_date) >= ${from}
          and coalesce(d.document_date, d.posting_date) <= ${to}
      ), numbered as (
        select *, ref_num - row_number() over (partition by party_id, currency order by ref_num) as island
        from refs
        where ref_num is not null and ref_num <= 9999999
      ), islands as (
        select party_id, currency, island, count(*) as cnt, coalesce(sum(func_amount), 0) as total_amount,
          min(ref_num) as start_ref, max(ref_num) as end_ref,
          min(doc_date) as first_date, max(doc_date) as last_date,
          (max(doc_date) - min(doc_date)) as span_days,
          jsonb_agg(jsonb_build_object('docId', id, 'docNumber', document_number, 'reference', reference_number,
            'date', doc_date::text, 'amount', amount, 'currency', currency, 'funcAmount', func_amount) order by ref_num) as invoices
        from numbered
        group by party_id, currency, island
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
  // sets is the non-qualifying remainder and is dropped. Benford sets are keyed
  // (currency, digit): one distribution per document currency.
  const dupAllRows = (dupAll.rows);
  const dupGroupRows = { rows: dupAllRows.filter((r) => r.src === "group") };
  const dupAgg = { rows: dupAllRows.filter((r) => r.src === "agg").map((r) => ({ total: r.group_count, amount: r.value_at_risk })) };

  const vendorStats = (vendorStatRows.rows);
  const rsfRows = { rows: vendorStats.filter((r) => r.src === "rsf").map((r) => ({ ...r, rsf: r.metric })) };
  const zRows = { rows: vendorStats.filter((r) => r.src === "z").map((r) => ({ ...r, z: r.metric })) };

  const aggAll = aggRows.rows as AggregateRow[];
  const gset = (flag: string, key: string) =>
    aggAll.filter((r) => Number(r[flag]) === 0 && r[key] !== null);
  const metaRows = {
    // The grand-total set: every flag 1, i.e. nothing is a group key.
    rows: aggAll
      .filter((r) => ["g_cur", "g_digit1", "g_digit2", "g_trap", "g_dow", "g_date"].every((f) => Number(r[f]) === 1))
      .map((r) => ({ docs: r.count, amount: r.amount })),
  };
  const b1Rows = {
    rows: aggAll
      .filter((r) => Number(r.g_digit1) === 0 && Number(r.g_cur) === 0 && r.digit1 !== null)
      .map((r) => ({ currency: String(r.cur), digit: r.digit1, count: r.count, amount: r.amount })),
  };
  const b2Rows = {
    rows: aggAll
      .filter((r) => Number(r.g_digit2) === 0 && Number(r.g_cur) === 0 && r.digit2 !== null)
      .map((r) => ({ currency: String(r.cur), digits: r.digit2, count: r.count, amount: r.amount })),
  };
  const trapAgg = { rows: gset("g_trap", "trap") };
  const weekendAgg = { rows: gset("g_dow", "dow") };
  const calRows = {
    rows: gset("g_date", "date").sort((a, b) => String(a.date).localeCompare(String(b.date))),
  };

  // ---- Benford 1D + 2D, one distribution per document currency --------------
  // Digit rows arrive keyed (currency, digit). Each currency gets its own
  // conformity computation over its own transaction amounts — a blended
  // distribution would compare economically different magnitudes. The legacy
  // top-level shape carries the largest slice so single-currency datasets
  // (and existing consumers) read byte-identical figures.
  const slice1D = (currency: string, rows: { digit: unknown; count: unknown; amount: unknown }[]): BenfordCurrencySlice => {
    const map = new Map<string, { count: number; amount: number }>(
      rows.map((r) => [String(r.digit), { count: Number(r.count), amount: Number(r.amount) }]),
    );
    const total = [...map.values()].reduce((s, v) => s + v.count, 0);
    let sumAbsDev = 0;
    const digits: BenfordDigit[] = [];
    for (let d = 1; d <= 9; d++) {
      const row = map.get(String(d));
      const observed = row && total > 0 ? row.count / total : 0;
      const expected = BENFORD_1D[d]!;
      const deviation = observed - expected;
      sumAbsDev += Math.abs(deviation);
      const deviationPct = expected > 0 ? (deviation / expected) * 100 : 0;
      digits.push({
        digit: d, count: row?.count ?? 0, amount: row?.amount ?? 0,
        observed, expected, deviationPct,
        isAnomaly: Math.abs(deviationPct) > 25,
      });
    }
    const mad = sumAbsDev / 9;
    return {
      currency, totalTransactions: total, digits, mad,
      conformity: conformity1D(mad),
      message:
        total < 50
          ? strings.benfordInsufficient(total)
          : mad <= 0.006
            ? strings.benfordClose
            : mad <= 0.012
              ? strings.benfordReasonable
              : mad <= 0.015
                ? strings.benfordSomeDeviation
                : strings.benfordSignificant,
      anomalies: digits.filter((x) => x.isAnomaly),
    };
  };
  const slice2D = (currency: string, rows: { digits: unknown; count: unknown; amount: unknown }[]): BenfordCurrencySlice => {
    const map = new Map<string, { count: number; amount: number }>(
      rows.map((r) => [String(r.digits), { count: Number(r.count), amount: Number(r.amount) }]),
    );
    const total = [...map.values()].reduce((s, v) => s + v.count, 0);
    let sumAbsDev = 0;
    const digits: BenfordDigit[] = [];
    for (let d = 10; d <= 99; d++) {
      const row = map.get(String(d));
      const observed = row && total > 0 ? row.count / total : 0;
      const expected = Math.log10(1 + 1 / d);
      const deviation = observed - expected;
      sumAbsDev += Math.abs(deviation);
      const deviationPct = expected > 0 ? (deviation / expected) * 100 : 0;
      digits.push({ digit: d, count: row?.count ?? 0, amount: row?.amount ?? 0, observed, expected, deviationPct, isAnomaly: Math.abs(deviationPct) > 50 });
    }
    const mad = sumAbsDev / 90;
    return {
      currency, totalTransactions: total, digits, mad,
      conformity: conformity2D(mad), message: "",
      anomalies: digits.filter((x) => x.isAnomaly && x.count >= 5).sort((a, b) => Math.abs(b.deviationPct) - Math.abs(a.deviationPct)),
    };
  };
  const byCurrency = <T extends { currency: string }>(rows: T[]): Map<string, T[]> => {
    const out = new Map<string, T[]>();
    for (const r of rows) {
      const list = out.get(r.currency);
      if (list) list.push(r);
      else out.set(r.currency, [r]);
    }
    return out;
  };
  const b1Slices = [...byCurrency(b1Rows.rows).entries()]
    .map(([currency, rows]) => slice1D(currency, rows))
    .sort((a, b) => b.totalTransactions - a.totalTransactions || (a.currency < b.currency ? -1 : 1));
  const b2Slices = [...byCurrency(b2Rows.rows).entries()]
    .map(([currency, rows]) => slice2D(currency, rows))
    .sort((a, b) => b.totalTransactions - a.totalTransactions || (a.currency < b.currency ? -1 : 1));
  const b1Top = b1Slices[0] ?? slice1D("", []);
  const b2Top = b2Slices[0] ?? slice2D("", []);
  const digits1D = b1Top.digits;
  const total1D = b1Top.totalTransactions;
  const mad1D = b1Top.mad;
  const benfordMessage = b1Top.message;
  const digits2D = b2Top.digits;
  const total2D = b2Top.totalTransactions;
  const mad2D = b2Top.mad;
  const anomalies2D = b2Top.anomalies;

  // ---- Threshold trap ------------------------------------------------------------
  const trapItems: FlaggedDoc[] = (trapRows.rows as FlaggedDocumentRow[]).map((r) => ({
    docId: r.id, docNumber: r.document_number ?? "", kind: r.kind, date: r.date,
    amount: Number(r.amount), currency: r.currency, funcAmount: Number(r.func_amount),
    partyId: r.party_id, partyName: r.party_name ?? "",
    flagType: "trap" as const,
    reason: strings.trapReason(r.trap as string),
    riskScore: r.trap === "9999" ? 65 : r.trap === "999" ? 55 : 45,
  }));
  const trapByTrap = ((trapAgg.rows)).map((r) => ({ trap: r.trap as string, count: Number(r.count), amount: Number(r.amount) }));
  const trapTotal = trapByTrap.reduce((s, t) => s + t.count, 0);

  // ---- Duplicates: one finding per natural-key group ---------------------------------
  const dupGroups: DuplicateGroup[] = (dupGroupRows.rows as DuplicateGroupRow[]).map((r) => {
    const amount = Number(r.amt);
    const count = Number(r.cnt);
    const spanDays = Number(r.span_days);
    const sameReference = r.refkey !== "";
    const members: DuplicateMember[] = (r.members ?? []).map((m) => ({
      docId: m.docId, docNumber: m.docNumber ?? "", reference: m.reference ?? "",
      date: m.date, amount: Number(m.amount), currency: m.currency,
      funcAmount: Number(m.funcAmount), memo: m.memo,
    }));
    let score = 50;
    if (amount >= CRITICAL_RISK_AMOUNT) score += 25;
    else if (amount >= HIGH_RISK_AMOUNT) score += 15;
    else if (amount >= 1000) score += 5;
    if (spanDays <= 1) score += 20;
    else if (spanDays <= 3) score += 15;
    else if (spanDays <= 7) score += 10;
    if (sameReference) score += 10;
    return {
      groupId: [r.party_id ?? "", r.kind, r.currency, String(amount), r.refkey].join("|"),
      partyId: r.party_id, partyName: r.party_name,
      kind: r.kind, currency: r.currency, amount, funcTotal: Number(r.func_total),
      count, dateSpanDays: spanDays, firstDate: r.first_date, lastDate: r.last_date,
      sameReference,
      confidence: sameReference ? 0.95 : spanDays <= 3 ? 0.9 : spanDays <= 7 ? 0.85 : 0.75,
      riskScore: Math.min(100, score),
      members,
    };
  });
  const dupTotal = Number(dupAgg.rows[0]?.total ?? 0);
  const dupAmount = Number(dupAgg.rows[0]?.amount ?? 0);

  // Compatibility projection for the assistant/MCP passthrough (owned by
  // another fleet): every within-group ordered pair, so pair-shaped readers
  // keep working. Same-currency and same-reference by construction — the
  // cross-currency false positive cannot appear here either.
  const dayDiff = (a: string, b: string) =>
    Math.abs(Math.round((new Date(a + "T00:00:00Z").getTime() - new Date(b + "T00:00:00Z").getTime()) / 86_400_000));
  const dupPairs: DuplicatePair[] = [];
  for (const g of dupGroups) {
    const ms = g.members;
    for (let i = 0; i < ms.length; i++) {
      for (let j = i + 1; j < ms.length; j++) {
        const a = ms[i]!, b = ms[j]!;
        const days = dayDiff(a.date, b.date);
        const sameMemo = a.memo !== null && a.memo === b.memo;
        let score = 50;
        if (g.amount >= CRITICAL_RISK_AMOUNT) score += 25;
        else if (g.amount >= HIGH_RISK_AMOUNT) score += 15;
        else if (g.amount >= 1000) score += 5;
        if (days <= 1) score += 20;
        else if (days <= 3) score += 15;
        else if (days <= 7) score += 10;
        if (sameMemo || g.sameReference) score += 10;
        dupPairs.push({
          docId1: a.docId, docId2: b.docId, docNumber1: a.docNumber, docNumber2: b.docNumber,
          kind: g.kind, date1: a.date, date2: b.date, daysBetween: days, amount: g.amount,
          currency: g.currency, partyId: g.partyId, partyName: g.partyName,
          sameMemo,
          confidence: sameMemo || g.sameReference ? 0.95 : days <= 3 ? 0.9 : days <= 7 ? 0.85 : 0.75,
          riskScore: Math.min(100, score),
        });
      }
    }
  }
  dupPairs.sort((x, y) => y.amount - x.amount || x.daysBetween - y.daysBetween
    || (x.docId1 < y.docId1 ? -1 : 1) || (x.docId2 < y.docId2 ? -1 : 1));
  const dupPairsCapped = dupPairs.slice(0, 200);

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
      amount, currency: r.currency, funcAmount: Number(r.func_amount),
      partyId: r.party_id, partyName: r.party_name ?? "",
      flagType: "weekend" as const,
      reason: strings.weekendReason(isSunday),
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
      amount, currency: r.currency, funcAmount: Number(r.func_amount),
      partyId: r.party_id, partyName: r.party_name ?? "",
      flagType: "rsf" as const,
      reason: strings.rsfReason(rsf.toFixed(1), strings.displayPartyName(r.party_name), String(r.currency)),
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
      amount, currency: r.currency, funcAmount: Number(r.func_amount),
      partyId: r.party_id, partyName: r.party_name ?? "",
      flagType: "zscore" as const,
      reason: strings.zscoreReason(Math.abs(z).toFixed(2), strings.displayPartyName(r.party_name), String(r.currency), Number(r.baseline_count)),
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
    const invoices = ((r.invoices)).map((inv) => ({
      docId: inv.docId, docNumber: inv.docNumber, reference: inv.reference, date: inv.date,
      amount: Number(inv.amount), currency: inv.currency, funcAmount: Number(inv.funcAmount),
    }));
    return {
      partyId: r.party_id, partyName: r.party_name, count, totalAmount,
      currency: r.currency,
      startRef: Number(r.start_ref), endRef: Number(r.end_ref), dateSpanDays: spanDays,
      firstDate: String(r.first_date), lastDate: String(r.last_date),
      riskLevel: level, riskScore: Math.min(100, score),
      reason: strings.sequentialReason(count, String(r.start_ref), String(r.end_ref), spanDays, level === "high", String(r.currency)),
      invoices: invoices.slice(0, 12),
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
        ? strings.ghostBoth(String(r.vendor_name), String(r.employee_name))
        : addr
          ? strings.ghostAddress(String(r.vendor_name), String(r.employee_name))
          : strings.ghostName(String(r.vendor_name), String(r.employee_name)),
    };
  }).sort((a, b) => b.riskScore - a.riskScore);

  // ---- Audit trail ---------------------------------------------------------------------------------
  // F-t09-006: every row renders a one-line human summary (who did what to
  // which record) instead of the raw changes envelope. The verb/actor/field
  // shaping is locale-free data; the sentence itself resolves through the
  // strings bundle in the request locale.
  const auditEvents: AuditEvent[] = (auditRows.rows as AuditRow[]).map((r) => ({
    id: r.id, tableName: r.table_name, rowId: r.row_id, action: r.action, actorId: r.actor_id, at: r.at,
    summary: strings.auditEvent(auditEventArgs(r.action, r.actor_id, r.table_name, r.row_id, r.changes)),
  }));
  const auditTotal = Number(auditAgg.rows[0]?.total ?? 0);
  const auditDeletes = Number(auditAgg.rows[0]?.deletes ?? 0);
  const auditSensitive = Number(auditAgg.rows[0]?.sensitive ?? 0);

  // ---- Flagged aggregate (dedup by doc, stable order) -----------------------------------------------
  const flagged: FlaggedDoc[] = [];
  const seen = new Set<string>();
  const push = (f: FlaggedDoc) => { if (!seen.has(f.docId)) { seen.add(f.docId); flagged.push(f); } };
  for (const g of dupGroups) {
    // The group scan includes the threshold-sized boundary on both sides of
    // the report period. Anchor the single group finding to its earliest
    // in-period member; the reason lists the whole group.
    const inPeriod = g.members.filter((m) => m.date >= from && m.date <= to);
    const anchor = inPeriod[0] ?? g.members[0]!;
    const others = g.members.filter((m) => m.docId !== anchor.docId).map((m) => m.docNumber || m.docId).join(", ");
    push({
      docId: anchor.docId,
      docNumber: anchor.docNumber,
      kind: g.kind,
      date: anchor.date,
      amount: g.amount,
      currency: g.currency,
      funcAmount: anchor.funcAmount,
      partyId: g.partyId,
      partyName: g.partyName,
      flagType: "duplicate",
      reason: strings.duplicateGroupReason({ count: g.count, currency: String(g.currency), amount: String(g.amount), sharedReference: g.sameReference && anchor.reference ? String(anchor.reference) : null, daysSpan: g.dateSpanDays, others }),
      riskScore: g.riskScore,
    });
  }
  for (const w of weekendItems) push(w);
  for (const r of rsfItems) push(r);
  for (const z of zItems) push(z);
  // Composite signal: duplicates + weekend + RSF + z-score + sequential-run
  // invoices (threshold-trap docs stay in their own tab, NOT in the aggregate).
  for (const s of sequential)
    for (const inv of s.invoices)
      push({ docId: inv.docId, docNumber: inv.docNumber, kind: "vendor_bill", date: inv.date, amount: inv.amount, currency: inv.currency, funcAmount: inv.funcAmount, partyId: s.partyId, partyName: s.partyName, flagType: "sequential", reason: s.reason, riskScore: s.riskScore });
  flagged.sort((a, b) => b.riskScore - a.riskScore);

  // ---- Vendor risk roll-up ---------------------------------------------------------------------------
  const vendorMap = new Map<string, SentinelData["vendorRisk"][number]>();
  for (const f of flagged) {
    const key = f.partyId ?? f.partyName ?? "unknown";
    let v = vendorMap.get(key);
    if (!v) { v = { partyId: f.partyId, partyName: strings.displayPartyName(f.partyName), flagCount: 0, totalAmount: 0, flagTypes: [], maxRiskScore: 0, compositeScore: 0 }; vendorMap.set(key, v); }
    v.flagCount++;
    v.totalAmount += Math.abs(f.funcAmount);
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
  if (conformity1D(mad1D) === "nonConforming") risk += 15;

  const topRiskAreas: SentinelData["summary"]["topRiskAreas"] = [];
  if (ghosts.length) topRiskAreas.push({ severity: "critical", count: ghosts.length, ...strings.riskGhosts(ghosts.length) });
  if (sequential.length) topRiskAreas.push({ severity: "high", count: sequential.length, ...strings.riskSequential(sequential.length) });
  if (dupTotal > 10) topRiskAreas.push({ severity: "high", count: dupTotal, ...strings.riskDuplicates(dupTotal) });
  if (trapTotal > 0) topRiskAreas.push({ severity: "high", count: trapTotal, ...strings.riskTraps(trapTotal) });
  if (conformity1D(mad1D) === "nonConforming") topRiskAreas.push({ severity: "medium", count: total1D, ...strings.riskBenford() });
  topRiskAreas.sort((a, b) => ({ critical: 0, high: 1, medium: 2 }[a.severity] - { critical: 0, high: 1, medium: 2 }[b.severity]));

  const meta = metaRows.rows[0] ?? { docs: 0, amount: 0 };
  const days = Math.round((end.getTime() - new Date(from + "T00:00:00Z").getTime()) / 86_400_000) + 1;

  return {
    period,
    meta: { totalDocs: Number(meta.docs ?? 0), totalAmount: Number(meta.amount ?? 0), presentationCurrency: presentationCcy, days, queryMs: Date.now() - t0 },
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
      totalAtRisk: flagged.reduce((s, f) => s + Math.abs(f.funcAmount), 0),
      overallRiskScore: Math.min(100, risk),
      benfordConformity: conformity1D(mad1D),
      benford2DConformity: conformity2D(mad2D),
      approvalLimitRisk: trapTotal > 0,
      topRiskAreas,
    },
    duplicates: { total: dupTotal, pairs: dupPairsCapped, groups: dupGroups },
    benford1D: { totalTransactions: total1D, digits: digits1D, mad: mad1D, conformity: conformity1D(mad1D), message: benfordMessage, byCurrency: b1Slices },
    benford2D: { totalTransactions: total2D, digits: digits2D, anomalies: anomalies2D, mad: mad2D, conformity: conformity2D(mad2D), byCurrency: b2Slices },
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

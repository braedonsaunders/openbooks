import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";

/**
 * Sentinel — transaction integrity forensics, a faithful port of Gantry's
 * Integrity dashboard (Lib_Integrity_Data.js) re-engineered for SCALE.
 *
 * Gantry's engine is artificially limited: a hard 30-day date-range cap,
 * per-vendor N+1 baseline queries, FETCH FIRST row caps, and client-side JS
 * analysis over the first few hundred rows. This port pushes every forensic
 * test into single-pass SQL over the FULL ledger — window functions for
 * per-vendor baselines (RSF, z-score), gaps-and-islands for sequential
 * invoice runs, set-based self-join for duplicates, GROUP BY digit for
 * Benford — so any period over any dataset size returns aggregates, with
 * only the top-N detail rows per detector shipped to the client.
 *
 * Tests (thresholds verbatim from Gantry):
 *  - Duplicates: same vendor + same doc kind + same amount within 14 days
 *    (≥$100, credits excluded); confidence by memo/date proximity.
 *  - Benford first-digit + first-two-digit distributions with Mean Absolute
 *    Deviation conformity bands (Nigrini), over EVERY spend document.
 *  - Threshold trap: amounts ending 99 / 999 / 9999 (approval-limit gaming).
 *  - Weekend documents: spend documents DATED Sat/Sun. (Gantry keys off the
 *    system created date; migrated openbooks data carries import timestamps,
 *    so the accounting date is the honest signal — stated in Configuration.)
 *  - RSF: amount ÷ vendor's historical 2nd-largest (36-month baseline) ≥ 10.
 *  - Z-score: |amount − vendor mean| / vendor σ ≥ 3 (baseline ≥ 5 txns, σ>10).
 *  - Sequential invoices: gap-free vendor reference-number runs spread over
 *    7+ days — the shell-company / sole-customer indicator.
 *  - Ghost vendors: company-vendor names matching employee names (openbooks
 *    parties carry no addresses/emails in this dataset — name rules only).
 *  - Audit trail: native audit_log events on parties/documents (deletes,
 *    banking/contact changes).
 */

const SPEND_KINDS = ["vendor_bill", "vendor_credit", "vendor_payment", "check", "expense_report", "journal", "customer_credit"] as const;

// Gantry constants, verbatim.
const DUPLICATE_THRESHOLD_DAYS = 14;
const DUPLICATE_MIN_AMOUNT = 100;
const HIGH_RISK_AMOUNT = 10_000;
const CRITICAL_RISK_AMOUNT = 25_000;
const Z_SCORE_THRESHOLD = 3;
const RSF_THRESHOLD = 10;
const SEQUENTIAL_MIN = 3;
const SEQUENTIAL_MIN_DAYS_FOR_FLAG = 7;
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
  flagType: "duplicate" | "weekend" | "rsf" | "zscore" | "trap";
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
  matchType: "exact" | "contains"; riskScore: number; reason: string;
}

export interface AuditEvent {
  id: string; tableName: string; rowId: string; action: string; actorId: string | null; at: string; summary: string;
}

export interface SentinelData {
  period: { from: string; to: string; label: string };
  meta: { totalDocs: number; totalAmount: number; days: number; queryMs: number };
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
  vendorRisk: { partyId: string | null; partyName: string; flagCount: number; totalAmount: number; flagTypes: string[]; maxRiskScore: number }[];
  calendar: { date: string; count: number; amount: number }[];
}

const conformity1D = (mad: number) => (mad <= 0.006 ? "Excellent" : mad <= 0.012 ? "Acceptable" : mad <= 0.015 ? "Marginal" : "Non-Conforming");
const conformity2D = (mad: number) => (mad <= 0.0012 ? "Excellent" : mad <= 0.0022 ? "Acceptable" : mad <= 0.0033 ? "Marginal" : "Non-Conforming");

// ---- main -------------------------------------------------------------------

export async function sentinelData(orgId: string, period: { from: string; to: string; label: string }): Promise<SentinelData> {
  const { from, to } = period;
  const t0 = Date.now();
  const kindsIn = sql.join(SPEND_KINDS.map((k) => sql`${k}`), sql`, `);

  // Baseline window for vendor statistics: 36 months before period end (Gantry).
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
    metaRows, b1Rows, b2Rows, trapRows, trapAgg, dupRows, dupAgg, weekendRows, weekendAgg,
    rsfRows, zRows, seqRows, ghostRows, auditRows, auditAgg, calRows,
  ] = await Promise.all([
    // Dataset meta — proof of full coverage.
    db.execute(sql`select count(*) as docs, coalesce(sum(abs(d.total)), 0) as amount ${periodDocs}`) as Promise<any>,

    // Benford first digit — one aggregate over EVERY document.
    db.execute(sql`
      select left(trunc(abs(d.total))::bigint::text, 1) as digit, count(*) as count, sum(abs(d.total)) as amount
      ${periodDocs}
      group by 1
    `) as Promise<any>,

    // Benford first-two digits (scale <10 amounts ×10, Gantry rule).
    db.execute(sql`
      select case when abs(d.total) >= 10 then left(trunc(abs(d.total))::bigint::text, 2)
                  else left(trunc(abs(d.total) * 10)::bigint::text, 2) end as digits,
        count(*) as count, sum(abs(d.total)) as amount
      ${periodDocs}
      group by 1
    `) as Promise<any>,

    // Threshold trap rows (top by amount) — SQL modular arithmetic, full scan.
    db.execute(sql`
      select d.id, d.document_number, d.kind, coalesce(d.document_date, d.posting_date)::text as date,
        abs(d.total) as amount, d.party_id, coalesce(p.display_name, '') as party_name,
        case when trunc(abs(d.total))::bigint % 10000 = 9999 then '9999'
             when trunc(abs(d.total))::bigint % 1000 = 999 then '999'
             else '99' end as trap
      from documents d
      left join parties p on p.id = d.party_id
      where d.org_id = ${orgId} and d.voided_at is null and d.kind in (${kindsIn})
        and coalesce(d.document_date, d.posting_date) >= ${from}
        and coalesce(d.document_date, d.posting_date) <= ${to}
        and abs(coalesce(d.total, 0)) >= 1
        and trunc(abs(d.total))::bigint % 100 = 99
        and round((abs(d.total) - trunc(abs(d.total))) * 100) in (0, 99)
      order by abs(d.total) desc
      limit 100
    `) as Promise<any>,
    db.execute(sql`
      select case when trunc(abs(d.total))::bigint % 10000 = 9999 then '9999'
                  when trunc(abs(d.total))::bigint % 1000 = 999 then '999'
                  else '99' end as trap,
        count(*) as count, sum(abs(d.total)) as amount
      ${periodDocs}
        and trunc(abs(d.total))::bigint % 100 = 99
        and round((abs(d.total) - trunc(abs(d.total))) * 100) in (0, 99)
      group by 1
    `) as Promise<any>,

    // Duplicates — set-based self-join over the whole period (credits excluded).
    db.execute(sql`
      select d1.id as id1, d2.id as id2, d1.document_number as num1, d2.document_number as num2,
        d1.kind, coalesce(d1.document_date, d1.posting_date)::text as date1,
        coalesce(d2.document_date, d2.posting_date)::text as date2,
        abs(coalesce(d2.document_date, d2.posting_date) - coalesce(d1.document_date, d1.posting_date)) as days_between,
        abs(d1.total) as amount, d1.party_id, coalesce(p.display_name, 'Unknown') as party_name,
        (d1.memo is not null and d1.memo = d2.memo) as same_memo
      from documents d1
      join documents d2 on d2.org_id = d1.org_id and d2.party_id = d1.party_id
        and d2.kind = d1.kind and abs(d2.total) = abs(d1.total) and d1.id < d2.id
        and d2.voided_at is null
        and abs(coalesce(d2.document_date, d2.posting_date) - coalesce(d1.document_date, d1.posting_date)) <= ${DUPLICATE_THRESHOLD_DAYS}
      left join parties p on p.id = d1.party_id
      where d1.org_id = ${orgId} and d1.voided_at is null
        and d1.kind in ('vendor_bill', 'check', 'expense_report', 'vendor_payment')
        and d1.party_id is not null
        and abs(coalesce(d1.total, 0)) >= ${DUPLICATE_MIN_AMOUNT}
        and coalesce(d1.document_date, d1.posting_date) >= ${from}
        and coalesce(d1.document_date, d1.posting_date) <= ${to}
      order by abs(d1.total) desc, days_between asc
      limit 200
    `) as Promise<any>,
    db.execute(sql`
      select count(*) as total, coalesce(sum(abs(d1.total)), 0) as amount
      from documents d1
      join documents d2 on d2.org_id = d1.org_id and d2.party_id = d1.party_id
        and d2.kind = d1.kind and abs(d2.total) = abs(d1.total) and d1.id < d2.id
        and d2.voided_at is null
        and abs(coalesce(d2.document_date, d2.posting_date) - coalesce(d1.document_date, d1.posting_date)) <= ${DUPLICATE_THRESHOLD_DAYS}
      where d1.org_id = ${orgId} and d1.voided_at is null
        and d1.kind in ('vendor_bill', 'check', 'expense_report', 'vendor_payment')
        and d1.party_id is not null
        and abs(coalesce(d1.total, 0)) >= ${DUPLICATE_MIN_AMOUNT}
        and coalesce(d1.document_date, d1.posting_date) >= ${from}
        and coalesce(d1.document_date, d1.posting_date) <= ${to}
    `) as Promise<any>,

    // Weekend-dated documents (top rows + full aggregate).
    db.execute(sql`
      select d.id, d.document_number, d.kind, coalesce(d.document_date, d.posting_date)::text as date,
        abs(d.total) as amount, d.party_id, coalesce(p.display_name, '') as party_name,
        extract(dow from coalesce(d.document_date, d.posting_date))::int as dow
      from documents d
      left join parties p on p.id = d.party_id
      where d.org_id = ${orgId} and d.voided_at is null and d.kind in (${kindsIn})
        and coalesce(d.document_date, d.posting_date) >= ${from}
        and coalesce(d.document_date, d.posting_date) <= ${to}
        and abs(coalesce(d.total, 0)) >= 1
        and extract(dow from coalesce(d.document_date, d.posting_date)) in (0, 6)
      order by abs(d.total) desc
      limit 200
    `) as Promise<any>,
    db.execute(sql`
      select extract(dow from coalesce(d.document_date, d.posting_date))::int as dow,
        count(*) as count, coalesce(sum(abs(d.total)), 0) as amount
      ${periodDocs}
        and extract(dow from coalesce(d.document_date, d.posting_date)) in (0, 6)
      group by 1
    `) as Promise<any>,

    // RSF — per-vendor top-2 baseline via ONE window-function pass (no N+1).
    db.execute(sql`
      with baseline as (
        select d.party_id, abs(d.total) as amount,
          row_number() over (partition by d.party_id order by abs(d.total) desc) as rn,
          count(*) over (partition by d.party_id) as cnt
        from documents d
        where d.org_id = ${orgId} and d.voided_at is null and d.kind in (${kindsIn})
          and d.party_id is not null and abs(coalesce(d.total, 0)) > 0
          and coalesce(d.document_date, d.posting_date) >= ${baselineFrom}
          and coalesce(d.document_date, d.posting_date) <= ${to}
      ), second_largest as (
        -- $100 floor: a near-zero historical 2nd-largest turns RSF into noise.
        select party_id, amount as second_amount, cnt from baseline where rn = 2 and amount >= 100
      )
      select d.id, d.document_number, d.kind, coalesce(d.document_date, d.posting_date)::text as date,
        abs(d.total) as amount, d.party_id, coalesce(p.display_name, 'Unknown') as party_name,
        s.second_amount, s.cnt as baseline_count,
        abs(d.total) / s.second_amount as rsf
      from documents d
      join second_largest s on s.party_id = d.party_id and s.second_amount > 0
      left join parties p on p.id = d.party_id
      where d.org_id = ${orgId} and d.voided_at is null and d.kind in (${kindsIn})
        and coalesce(d.document_date, d.posting_date) >= ${from}
        and coalesce(d.document_date, d.posting_date) <= ${to}
        and abs(d.total) / s.second_amount >= ${RSF_THRESHOLD}
      order by rsf desc
      limit 100
    `) as Promise<any>,

    // Z-score — per-vendor mean/σ baseline in ONE aggregate pass.
    db.execute(sql`
      with baseline as (
        select d.party_id, count(*) as cnt, avg(abs(d.total)) as avg_amount, stddev_samp(abs(d.total)) as std_amount
        from documents d
        where d.org_id = ${orgId} and d.voided_at is null and d.kind in (${kindsIn})
          and d.party_id is not null and abs(coalesce(d.total, 0)) > 0
          and coalesce(d.document_date, d.posting_date) >= ${baselineFrom}
          and coalesce(d.document_date, d.posting_date) <= ${to}
        group by d.party_id
        having count(*) >= 5 and stddev_samp(abs(d.total)) > 10
      )
      select d.id, d.document_number, d.kind, coalesce(d.document_date, d.posting_date)::text as date,
        abs(d.total) as amount, d.party_id, coalesce(p.display_name, 'Unknown') as party_name,
        b.avg_amount, b.std_amount, b.cnt as baseline_count,
        (abs(d.total) - b.avg_amount) / b.std_amount as z
      from documents d
      join baseline b on b.party_id = d.party_id
      left join parties p on p.id = d.party_id
      where d.org_id = ${orgId} and d.voided_at is null and d.kind in (${kindsIn})
        and coalesce(d.document_date, d.posting_date) >= ${from}
        and coalesce(d.document_date, d.posting_date) <= ${to}
        and abs((abs(d.total) - b.avg_amount) / b.std_amount) >= ${Z_SCORE_THRESHOLD}
        and abs((abs(d.total) - b.avg_amount) / b.std_amount) < 50
      order by abs((abs(d.total) - b.avg_amount) / b.std_amount) desc
      limit 200
    `) as Promise<any>,

    // Sequential invoice runs — gaps-and-islands over vendor reference numbers.
    db.execute(sql`
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
      left join parties p on p.id = i.party_id
      where i.span_days >= ${SEQUENTIAL_MIN_DAYS_FOR_FLAG}
      order by i.span_days desc, i.total_amount desc
      limit 50
    `) as Promise<any>,

    // Ghost vendors — company-vendor names vs employee names (SQL, full sets).
    db.execute(sql`
      select v.id as vendor_id, v.display_name as vendor_name,
        e.id as employee_id, e.display_name as employee_name,
        (upper(trim(v.display_name)) = upper(trim(e.display_name))) as exact_match
      from parties v
      join parties e on e.org_id = v.org_id and e.kind = 'person' and e.id != v.id
        and length(trim(e.display_name)) >= 7
        and (
          upper(trim(v.display_name)) = upper(trim(e.display_name))
          or upper(v.display_name) like '%' || upper(trim(e.display_name)) || '%'
        )
      where v.org_id = ${orgId} and v.kind = 'company' and v.is_active
        and e.is_active
        and exists (
          select 1 from documents dv
          where dv.org_id = v.org_id and dv.party_id = v.id
            and dv.kind in ('vendor_bill', 'check', 'vendor_payment')
        )
      limit 50
    `) as Promise<any>,

    // Native audit trail — deletes + sensitive-field changes on master data.
    db.execute(sql`
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
    `) as Promise<any>,
    db.execute(sql`
      select count(*) as total,
        count(*) filter (where action in ('delete', 'DELETE')) as deletes,
        count(*) filter (where changes::text ~* 'bank|routing|iban|account_number|email|address') as sensitive
      from audit_log
      where org_id = ${orgId} and at >= ${from}::date and at < (${to}::date + interval '1 day')
    `) as Promise<any>,

    // Calendar heatmap — spend document count/amount per day, full period.
    db.execute(sql`
      select coalesce(d.document_date, d.posting_date)::text as date, count(*) as count, sum(abs(d.total)) as amount
      ${periodDocs}
      group by 1
      order by 1
    `) as Promise<any>,
  ]);

  // ---- Benford 1D --------------------------------------------------------------
  const b1Map = new Map<string, { count: number; amount: number }>(
    (b1Rows.rows as any[]).map((r) => [r.digit, { count: Number(r.count), amount: Number(r.amount) }]),
  );
  const total1D = [...b1Map.values()].reduce((s, v) => s + v.count, 0);
  let sumAbsDev1 = 0;
  const digits1D: BenfordDigit[] = [];
  for (let d = 1; d <= 9; d++) {
    const row = b1Map.get(String(d));
    const observed = row && total1D > 0 ? row.count / total1D : 0;
    const expected = BENFORD_1D[d];
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
    (b2Rows.rows as any[]).map((r) => [r.digits, { count: Number(r.count), amount: Number(r.amount) }]),
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
  const trapItems: FlaggedDoc[] = (trapRows.rows as any[]).map((r) => ({
    docId: r.id, docNumber: r.document_number ?? "", kind: r.kind, date: r.date,
    amount: Number(r.amount), partyId: r.party_id, partyName: r.party_name ?? "",
    flagType: "trap" as const,
    reason: `Amount ends in ${r.trap} (potential threshold avoidance)`,
    riskScore: r.trap === "9999" ? 65 : r.trap === "999" ? 55 : 45,
  }));
  const trapByTrap = (trapAgg.rows as any[]).map((r) => ({ trap: r.trap as string, count: Number(r.count), amount: Number(r.amount) }));
  const trapTotal = trapByTrap.reduce((s, t) => s + t.count, 0);

  // ---- Duplicates ------------------------------------------------------------------
  const dupPairs: DuplicatePair[] = (dupRows.rows as any[]).map((r) => {
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
  const weekendItems: FlaggedDoc[] = (weekendRows.rows as any[]).map((r) => {
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
  for (const r of weekendAgg.rows as any[]) {
    if (Number(r.dow) === 0) sunCount = Number(r.count);
    else satCount = Number(r.count);
    weekendAmount += Number(r.amount);
  }
  const weekendTotal = satCount + sunCount;

  // ---- RSF ------------------------------------------------------------------------------
  const rsfItems = (rsfRows.rows as any[]).map((r) => {
    const rsf = Number(r.rsf);
    const amount = Number(r.amount);
    let score = 40;
    if (rsf >= 50) score += 40; else if (rsf >= 20) score += 30; else if (rsf >= 15) score += 20; else score += 10;
    if (amount >= CRITICAL_RISK_AMOUNT) score += 15; else if (amount >= HIGH_RISK_AMOUNT) score += 10;
    return {
      docId: r.id, docNumber: r.document_number ?? "", kind: r.kind, date: r.date,
      amount, partyId: r.party_id, partyName: r.party_name,
      flagType: "rsf" as const,
      reason: `${rsf.toFixed(1)}× larger than ${r.party_name}'s historical 2nd largest`,
      riskScore: Math.min(100, score),
      rsf, secondLargest: Number(r.second_amount), baselineCount: Number(r.baseline_count),
    };
  });

  // ---- Z-score ------------------------------------------------------------------------------
  const zItems = (zRows.rows as any[]).map((r) => {
    const z = Number(r.z);
    const amount = Number(r.amount);
    let score = 45;
    if (Math.abs(z) >= 5) score += 30; else if (Math.abs(z) >= 4) score += 20;
    if (amount >= CRITICAL_RISK_AMOUNT) score += 15;
    return {
      docId: r.id, docNumber: r.document_number ?? "", kind: r.kind, date: r.date,
      amount, partyId: r.party_id, partyName: r.party_name,
      flagType: "zscore" as const,
      reason: `Z-score ${Math.abs(z).toFixed(2)} vs ${r.party_name} average (${r.baseline_count} txns)`,
      riskScore: Math.min(100, score),
      zScore: z, vendorAvg: Number(r.avg_amount), vendorStdDev: Number(r.std_amount), baselineCount: Number(r.baseline_count),
    };
  });

  // ---- Sequential runs -----------------------------------------------------------------------
  const sequential: SequentialGroup[] = (seqRows.rows as any[]).map((r) => {
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
      invoices: (r.invoices as any[]).slice(0, 12),
    };
  });

  // ---- Ghost vendors -----------------------------------------------------------------------------
  const ghosts: GhostVendor[] = (ghostRows.rows as any[]).map((r) => ({
    vendorId: r.vendor_id, vendorName: r.vendor_name, employeeId: r.employee_id, employeeName: r.employee_name,
    matchType: r.exact_match ? "exact" : "contains",
    riskScore: r.exact_match ? 90 : 75,
    reason: r.exact_match
      ? `Vendor "${r.vendor_name}" exactly matches employee "${r.employee_name}"`
      : `Vendor "${r.vendor_name}" contains employee name "${r.employee_name}"`,
  }));

  // ---- Audit trail ---------------------------------------------------------------------------------
  const auditEvents: AuditEvent[] = (auditRows.rows as any[]).map((r) => ({
    id: r.id, tableName: r.table_name, rowId: r.row_id, action: r.action, actorId: r.actor_id, at: r.at,
    summary: r.changes || "",
  }));
  const auditTotal = Number(auditAgg.rows[0]?.total ?? 0);
  const auditDeletes = Number(auditAgg.rows[0]?.deletes ?? 0);
  const auditSensitive = Number(auditAgg.rows[0]?.sensitive ?? 0);

  // ---- Flagged aggregate (dedup by doc, Gantry order) -----------------------------------------------
  const flagged: FlaggedDoc[] = [];
  const seen = new Set<string>();
  const push = (f: FlaggedDoc) => { if (!seen.has(f.docId)) { seen.add(f.docId); flagged.push(f); } };
  for (const d of dupPairs) push({ docId: d.docId1, docNumber: d.docNumber1, kind: d.kind, date: d.date1, amount: d.amount, partyId: d.partyId, partyName: d.partyName, flagType: "duplicate", reason: `Same vendor, kind & amount as ${d.docNumber2 || "pair"} (${d.daysBetween}d apart)`, riskScore: d.riskScore });
  for (const w of weekendItems) push(w);
  for (const r of rsfItems) push(r);
  for (const z of zItems) push(z);
  for (const t of trapItems) push(t);
  flagged.sort((a, b) => b.riskScore - a.riskScore);

  // ---- Vendor risk roll-up ---------------------------------------------------------------------------
  const vendorMap = new Map<string, SentinelData["vendorRisk"][number]>();
  for (const f of flagged) {
    const key = f.partyId ?? f.partyName ?? "unknown";
    let v = vendorMap.get(key);
    if (!v) { v = { partyId: f.partyId, partyName: f.partyName || "Unknown", flagCount: 0, totalAmount: 0, flagTypes: [], maxRiskScore: 0 }; vendorMap.set(key, v); }
    v.flagCount++;
    v.totalAmount += Math.abs(f.amount);
    v.maxRiskScore = Math.max(v.maxRiskScore, f.riskScore);
    if (!v.flagTypes.includes(f.flagType)) v.flagTypes.push(f.flagType);
  }
  const vendorRisk = [...vendorMap.values()].sort((a, b) => b.maxRiskScore - a.maxRiskScore || b.totalAmount - a.totalAmount).slice(0, 50);

  // ---- Summary (verbatim Gantry risk model) ------------------------------------------------------------
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

  const meta = metaRows.rows[0] ?? {};
  const days = Math.round((end.getTime() - new Date(from + "T00:00:00Z").getTime()) / 86_400_000) + 1;

  return {
    period,
    meta: { totalDocs: Number(meta.docs ?? 0), totalAmount: Number(meta.amount ?? 0), days, queryMs: Date.now() - t0 },
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
    calendar: (calRows.rows as any[]).map((r) => ({ date: r.date, count: Number(r.count), amount: Number(r.amount) })),
  };
}

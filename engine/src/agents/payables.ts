import { sql } from "drizzle-orm";
import { businessToday } from "../business-date.ts";
import { db } from "../db.ts";
import { fromUnits, toUnits } from "../money.ts";
import {
  effectiveDetectorMateriality,
  type ContinuousCloseDetectorPolicy,
} from "../continuous-close-config.ts";
import { absoluteUnits, moneyAbs } from "./measure.ts";
import type { AgentFinding } from "./types.ts";

/**
 * Payables pack — duplicate/near-duplicate bills, bills due before the next
 * pay run, early-pay discount opportunities, and bills missing approvals.
 *
 * Reuse map (engine cannot import web/ code, so predicates are mirrored in
 * engine-native SQL and cited):
 * - duplicate_bills mirrors Sentinel's duplicate rule
 *   (`web/lib/analytics/sentinel-data.ts`): same vendor + same doc kind +
 *   same absolute amount within N days, credits excluded by kind,
 *   confidence by memo proximity. Scoped to pairs with at least one OPEN leg:
 *   Sentinel scans full history for forensics; the payables pack surfaces
 *   what is still actionable (double entry, or a double payment where one leg
 *   remains open).
 * - bills_due_before_payrun mirrors the AP cockpit planner ordering
 *   (`web/lib/cash/ap-position.ts` `PayRunPlan`: oldest-due first); the
 *   finding summary IS the pay-run review card (no pay-run application tool
 *   exists to propose — the user confirms in the cockpit, where caps apply).
 * - bills_missing_approval mirrors the gateless-document predicate of
 *   `engine/src/approval-worklist.ts` `worklistDocuments` (stale
 *   draft/pending_approval, no void request, no pending flow gate), minus the
 *   per-user self-submission exclusion, which has no meaning for a
 *   background agent.
 *
 * The pack never writes.
 */

export const PAYABLES_DETECTOR_KEYS = [
  "duplicate_bills",
  "bills_due_before_payrun",
  "early_pay_discount_opportunity",
  "bills_missing_approval",
] as const;

export type DuplicateBillPair = {
  openDocId: string;
  openDocNumber: string | null;
  otherDocId: string;
  otherDocNumber: string | null;
  kind: string;
  openDate: string;
  otherDate: string;
  daysBetween: number;
  amount: string;
  openBalance: string;
  otherOpenBalance: string;
  otherIsOpen: boolean;
  partyId: string;
  partyName: string;
  sameMemo: boolean;
};

export type PayrunBillRow = {
  docId: string;
  docNumber: string | null;
  partyId: string | null;
  partyName: string;
  dueDate: string;
  openBalance: string;
};

export type DiscountOpportunityRow = {
  termId: string;
  termName: string;
  discountPercent: string;
  discountDays: number;
  docId: string;
  docNumber: string | null;
  partyName: string;
  documentDate: string;
  openBalance: string;
  discountValue: string;
};

export type StaleApprovalRow = {
  docId: string;
  docNumber: string | null;
  kind: string;
  partyName: string;
  documentDate: string;
  status: string;
  total: string;
};

export type PayablesLoaders = {
  /** Org business day (business-date.ts); injectable so unit tests stay DB-free. */
  today: (orgId: string) => Promise<string>;
  duplicatePairs: (orgId: string, windowDays: number, floor: string) => Promise<DuplicateBillPair[]>;
  payrunBills: (orgId: string, horizonEnd: string) => Promise<{ due: PayrunBillRow[]; beyondCount: number; beyondTotal: string }>;
  discountOpportunities: (orgId: string, minPercent: number) => Promise<DiscountOpportunityRow[]>;
  staleApprovals: (orgId: string, cutoff: string) => Promise<StaleApprovalRow[]>;
};

function shiftDaysIso(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function loadDuplicatePairs(orgId: string, windowDays: number, floor: string): Promise<DuplicateBillPair[]> {
  // Kinds narrow Sentinel's spend set to bills: checks and vendor payments
  // are payment instruments whose duplicates surface in banking, not AP.
  const rows = (await db.execute<{
    open_doc_id: string;
    open_doc_number: string | null;
    other_doc_id: string;
    other_doc_number: string | null;
    kind: string;
    open_date: string;
    other_date: string;
    days_between: number;
    amount: string;
    open_balance: string;
    other_open_balance: string;
    other_is_open: boolean;
    party_id: string;
    party_name: string;
    same_memo: boolean;
  }>(sql`
    with open_bills as (
      select id, document_number, kind, party_id, memo, abs(total) as amt,
             abs(open_balance) as open_amt,
             coalesce(document_date, posting_date) as ddate
        from documents
       where org_id = ${orgId} and voided_at is null
         and kind in ('vendor_bill', 'expense_report')
         and status = 'posted' and open_balance <> 0 and party_id is not null
         and abs(coalesce(total, 0)) >= ${floor}
    )
    select o.id as open_doc_id, o.document_number as open_doc_number,
           d.id as other_doc_id, d.document_number as other_doc_number,
           o.kind, o.ddate::text as open_date,
           coalesce(d.document_date, d.posting_date)::text as other_date,
           abs(coalesce(d.document_date, d.posting_date) - o.ddate) as days_between,
           o.amt::text as amount, o.open_amt::text as open_balance,
           abs(coalesce(d.open_balance, 0))::text as other_open_balance,
           (d.status = 'posted' and d.open_balance <> 0) as other_is_open,
           o.party_id, coalesce(p.display_name, 'Unknown') as party_name,
           (o.memo is not null and o.memo = d.memo) as same_memo
      from open_bills o
      join documents d on d.org_id = ${orgId} and d.voided_at is null
        and d.kind = o.kind and d.party_id = o.party_id and abs(d.total) = o.amt
        and d.id <> o.id
        and abs(coalesce(d.document_date, d.posting_date) - o.ddate) <= ${windowDays}
        -- Each unordered pair surfaces once: the open leg drives, except an
        -- open/open pair which the greater id owns.
        and (d.id > o.id or d.status <> 'posted' or d.open_balance = 0)
      left join parties p on p.id = o.party_id and p.org_id = ${orgId}
     order by o.amt desc, days_between asc, o.id, d.id
     limit 200
  `));
  return rows.rows.map((row) => ({
    openDocId: row.open_doc_id,
    openDocNumber: row.open_doc_number,
    otherDocId: row.other_doc_id,
    otherDocNumber: row.other_doc_number,
    kind: row.kind,
    openDate: String(row.open_date),
    otherDate: String(row.other_date),
    daysBetween: Number(row.days_between),
    amount: moneyAbs(row.amount),
    openBalance: moneyAbs(row.open_balance),
    otherOpenBalance: moneyAbs(row.other_open_balance),
    otherIsOpen: row.other_is_open,
    partyId: row.party_id,
    partyName: row.party_name,
    sameMemo: row.same_memo,
  }));
}

async function loadPayrunBills(orgId: string, horizonEnd: string): Promise<{ due: PayrunBillRow[]; beyondCount: number; beyondTotal: string }> {
  const [due, beyond] = await Promise.all([
    db.execute<{
      doc_id: string;
      doc_number: string | null;
      party_id: string | null;
      party_name: string;
      due_date: string;
      open_balance: string;
    }>(sql`
      select d.id as doc_id, d.document_number as doc_number, d.party_id,
             coalesce(p.display_name, 'Unspecified') as party_name,
             d.due_date::text as due_date, abs(d.open_balance)::text as open_balance
        from documents d
        left join parties p on p.id = d.party_id and p.org_id = d.org_id
       where d.org_id = ${orgId} and d.voided_at is null
         and d.kind in ('vendor_bill', 'expense_report')
         and d.status = 'posted' and d.open_balance <> 0
         and d.due_date is not null and d.due_date <= ${horizonEnd}
       order by d.due_date, abs(d.open_balance) desc
       limit 25
    `),
    db.execute<{ beyond_count: number; beyond_total: string }>(sql`
      select count(*)::int as beyond_count,
             coalesce(sum(abs(d.open_balance)), 0)::text as beyond_total
        from documents d
       where d.org_id = ${orgId} and d.voided_at is null
         and d.kind in ('vendor_bill', 'expense_report')
         and d.status = 'posted' and d.open_balance <> 0
         and (d.due_date is null or d.due_date > ${horizonEnd})
    `),
  ]);
  return {
    due: due.rows.map((row) => ({
      docId: row.doc_id,
      docNumber: row.doc_number,
      partyId: row.party_id,
      partyName: row.party_name,
      dueDate: String(row.due_date),
      openBalance: moneyAbs(row.open_balance),
    })),
    beyondCount: Number(beyond.rows[0]?.beyond_count ?? 0),
    beyondTotal: moneyAbs(beyond.rows[0]?.beyond_total ?? "0"),
  };
}

async function loadDiscountOpportunities(orgId: string, minPercent: number): Promise<DiscountOpportunityRow[]> {
  const today = await businessToday(orgId);
  const rows = (await db.execute<{
    term_id: string;
    term_name: string;
    discount_percent: string;
    discount_days: number;
    doc_id: string;
    doc_number: string | null;
    party_name: string;
    document_date: string;
    open_balance: string;
    discount_value: string;
  }>(sql`
    select t.id as term_id, t.name as term_name,
           t.discount_percent::text as discount_percent,
           t.discount_days as discount_days,
           d.id as doc_id, d.document_number as doc_number,
           coalesce(p.display_name, 'Unspecified') as party_name,
           d.document_date::text as document_date,
           abs(d.open_balance)::text as open_balance,
           (abs(d.open_balance) * t.discount_percent / 100)::text as discount_value
      from payment_terms t
      join documents d on d.org_id = t.org_id
      left join parties p on p.id = d.party_id and p.org_id = d.org_id
     where t.org_id = ${orgId} and t.is_active
       and t.discount_percent is not null and t.discount_days is not null
       and t.discount_percent >= ${minPercent}
       and d.voided_at is null and d.kind = 'vendor_bill'
       and d.status = 'posted' and d.open_balance <> 0
       and d.document_date is not null
       and d.document_date + t.discount_days >= ${today}
     order by (abs(d.open_balance) * t.discount_percent / 100) desc
     limit 100
  `));
  return rows.rows.map((row) => ({
    termId: row.term_id,
    termName: row.term_name,
    discountPercent: String(row.discount_percent),
    discountDays: Number(row.discount_days),
    docId: row.doc_id,
    docNumber: row.doc_number,
    partyName: row.party_name,
    documentDate: String(row.document_date),
    openBalance: moneyAbs(row.open_balance),
    discountValue: moneyAbs(row.discount_value),
  }));
}

async function loadStaleApprovals(orgId: string, cutoff: string): Promise<StaleApprovalRow[]> {
  const rows = (await db.execute<{
    doc_id: string;
    doc_number: string | null;
    kind: string;
    party_name: string;
    document_date: string;
    status: string;
    total: string;
  }>(sql`
    select d.id as doc_id, d.document_number as doc_number, d.kind,
           coalesce(p.display_name, 'Unspecified') as party_name,
           coalesce(d.document_date, d.posting_date)::text as document_date,
           d.status::text as status, abs(coalesce(d.total, 0))::text as total
      from documents d
      left join parties p on p.id = d.party_id and p.org_id = d.org_id
     where d.org_id = ${orgId} and d.voided_at is null
       and d.kind in ('vendor_bill', 'expense_report')
       and d.status in ('draft', 'pending_approval')
       and d.void_requested_at is null
       and coalesce(d.document_date, d.posting_date) <= ${cutoff}
       and not exists (
         select 1 from flow_gates g
          where g.org_id = d.org_id and g.subject_id = d.id and g.status = 'pending'
       )
     order by coalesce(d.document_date, d.posting_date), abs(coalesce(d.total, 0)) desc
     limit 50
  `));
  return rows.rows.map((row) => ({
    docId: row.doc_id,
    docNumber: row.doc_number,
    kind: row.kind,
    partyName: row.party_name,
    documentDate: String(row.document_date),
    status: row.status,
    total: moneyAbs(row.total),
  }));
}

export const productionPayablesLoaders: PayablesLoaders = {
  today: businessToday,
  duplicatePairs: loadDuplicatePairs,
  payrunBills: loadPayrunBills,
  discountOpportunities: loadDiscountOpportunities,
  staleApprovals: loadStaleApprovals,
};

export async function payablesFindings(
  orgId: string,
  agentThreshold: string,
  detectors: ContinuousCloseDetectorPolicy[],
  loaders: PayablesLoaders = productionPayablesLoaders,
): Promise<AgentFinding[]> {
  const today = await loaders.today(orgId);
  const findings: AgentFinding[] = [];
  const byKey = new Map(detectors.map((detector) => [detector.detectorKey, detector]));

  const duplicatePolicy = byKey.get("duplicate_bills");
  if (duplicatePolicy?.enabled) {
    const threshold = effectiveDetectorMateriality(duplicatePolicy, agentThreshold);
    const pairs = await loaders.duplicatePairs(
      orgId,
      duplicatePolicy.parameters.duplicateWindowDays!,
      threshold,
    );
    if (pairs.length > 0) {
      // Distinct open legs across both sides: an open/open pair exposes both
      // legs, an open/paid pair only the open one.
      const openLegs = new Map<string, string>();
      for (const pair of pairs) {
        openLegs.set(pair.openDocId, pair.openBalance);
        if (pair.otherIsOpen) openLegs.set(pair.otherDocId, pair.otherOpenBalance);
      }
      const materiality = fromUnits(
        [...openLegs.values()].reduce((sum, balance) => sum + toUnits(balance), 0n),
      );
      findings.push({
        agentKey: "payables",
        findingType: "duplicate_bills",
        fingerprint: "payables-duplicates",
        severity: pairs.length >= duplicatePolicy.parameters.criticalPairCount! ? "critical" : "warning",
        confidence: pairs.some((pair) => pair.sameMemo) ? "0.9000" : "0.7500",
        materiality,
        subjectType: "documents",
        summary: {
          pairCount: pairs.length,
          openExposure: materiality,
          review: "Confirm whether each pair is a double entry (void one leg) or a double payment (recover the second payment).",
          href: "/purchasing",
        },
        evidence: pairs.slice(0, 10).map((pair) => ({
          kind: "duplicate_bill_pair",
          sourceType: "document",
          sourceId: pair.openDocId,
          data: {
            openDocumentNumber: pair.openDocNumber,
            otherDocumentId: pair.otherDocId,
            otherDocumentNumber: pair.otherDocNumber,
            vendor: pair.partyName,
            kind: pair.kind,
            openDate: pair.openDate,
            otherDate: pair.otherDate,
            daysBetween: pair.daysBetween,
            amount: pair.amount,
            openBalance: pair.openBalance,
            otherOpenBalance: pair.otherOpenBalance,
            sameMemo: pair.sameMemo,
          },
        })),
      });
    }
  }

  const payrunPolicy = byKey.get("bills_due_before_payrun");
  if (payrunPolicy?.enabled) {
    const threshold = effectiveDetectorMateriality(payrunPolicy, agentThreshold);
    const horizonEnd = shiftDaysIso(today, payrunPolicy.parameters.payRunHorizonDays!);
    const { due, beyondCount, beyondTotal } = await loaders.payrunBills(orgId, horizonEnd);
    if (due.length > 0) {
      const materiality = fromUnits(due.reduce((sum, bill) => sum + toUnits(bill.openBalance), 0n));
      findings.push({
        agentKey: "payables",
        findingType: "bills_due_before_payrun",
        fingerprint: "payables-payrun",
        severity:
          due.length >= payrunPolicy.parameters.criticalItemCount! ||
          absoluteUnits(materiality) >= absoluteUnits(threshold) * BigInt(payrunPolicy.parameters.criticalMaterialityMultiple!)
            ? "critical"
            : "warning",
        confidence: "1.0000",
        materiality,
        subjectType: "documents",
        summary: {
          horizonEnd,
          dueCount: due.length,
          dueTotal: materiality,
          beyondHorizonCount: beyondCount,
          beyondHorizonTotal: beyondTotal,
          review: "Pay-run review card, oldest-due first (AP cockpit planner order). Apply the weekly AP cap in the cockpit before releasing.",
          recommended: due.map((bill) => ({
            documentId: bill.docId,
            documentNumber: bill.docNumber,
            vendor: bill.partyName,
            dueDate: bill.dueDate,
            openBalance: bill.openBalance,
          })),
          href: "/purchasing",
        },
        evidence: due.slice(0, 10).map((bill) => ({
          kind: "payrun_bill",
          sourceType: "document",
          sourceId: bill.docId,
          data: {
            documentNumber: bill.docNumber,
            vendor: bill.partyName,
            dueDate: bill.dueDate,
            openBalance: bill.openBalance,
          },
        })),
      });
    }
  }

  const discountPolicy = byKey.get("early_pay_discount_opportunity");
  if (discountPolicy?.enabled) {
    const threshold = effectiveDetectorMateriality(discountPolicy, agentThreshold);
    const rows = await loaders.discountOpportunities(orgId, discountPolicy.parameters.minimumDiscountPercent!);
    const byTerm = new Map<string, DiscountOpportunityRow[]>();
    for (const row of rows) {
      const list = byTerm.get(row.termId) ?? [];
      list.push(row);
      byTerm.set(row.termId, list);
    }
    for (const [termId, bills] of byTerm) {
      const materiality = fromUnits(bills.reduce((sum, bill) => sum + toUnits(bill.discountValue), 0n));
      if (absoluteUnits(materiality) < absoluteUnits(threshold)) continue;
      findings.push({
        agentKey: "payables",
        findingType: "early_pay_discount_opportunity",
        fingerprint: `payables-discount:${termId}`,
        severity:
          absoluteUnits(materiality) >= absoluteUnits(threshold) * 5n ? "critical" : "warning",
        confidence: "0.8500",
        materiality,
        subjectType: "payment_term",
        subjectId: termId,
        summary: {
          termName: bills[0]!.termName,
          discountPercent: bills[0]!.discountPercent,
          discountDays: bills[0]!.discountDays,
          billCount: bills.length,
          discountValue: materiality,
          review: "Pay these bills inside the discount window and claim the terms; confirm the vendor still honours them first.",
          href: "/purchasing",
        },
        evidence: bills.slice(0, 10).map((bill) => ({
          kind: "discount_bill",
          sourceType: "document",
          sourceId: bill.docId,
          data: {
            documentNumber: bill.docNumber,
            vendor: bill.partyName,
            documentDate: bill.documentDate,
            openBalance: bill.openBalance,
            discountValue: bill.discountValue,
          },
        })),
      });
    }
  }

  const approvalPolicy = byKey.get("bills_missing_approval");
  if (approvalPolicy?.enabled) {
    const threshold = effectiveDetectorMateriality(approvalPolicy, agentThreshold);
    const cutoff = shiftDaysIso(today, -(approvalPolicy.parameters.staleAfterDays!));
    const rows = await loaders.staleApprovals(orgId, cutoff);
    if (rows.length > 0) {
      const materiality = fromUnits(rows.reduce((sum, row) => sum + toUnits(row.total), 0n));
      findings.push({
        agentKey: "payables",
        findingType: "bills_missing_approval",
        fingerprint: "payables-approvals",
        severity:
          rows.length >= approvalPolicy.parameters.criticalItemCount! ||
          absoluteUnits(materiality) >= absoluteUnits(threshold) * BigInt(approvalPolicy.parameters.criticalMaterialityMultiple!)
            ? "critical"
            : "warning",
        confidence: "1.0000",
        materiality,
        subjectType: "documents",
        summary: {
          count: rows.length,
          oldestDate: rows.map((row) => row.documentDate).sort()[0],
          review: "Approve, reject, or send back these stalled bills so the close is not held up.",
          href: "/purchasing",
        },
        evidence: rows.slice(0, 10).map((row) => ({
          kind: "stalled_bill",
          sourceType: "document",
          sourceId: row.docId,
          data: {
            documentNumber: row.docNumber,
            kind: row.kind,
            vendor: row.partyName,
            documentDate: row.documentDate,
            status: row.status,
            total: row.total,
          },
        })),
      });
    }
  }

  return findings;
}

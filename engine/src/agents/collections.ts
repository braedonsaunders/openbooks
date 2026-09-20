import { sql } from "drizzle-orm";
import { businessToday } from "../platform/business-date.ts";
import { db } from "../platform/db.ts";
import { fromUnits, toUnits } from "../money/money.ts";
import {
  effectiveDetectorMateriality,
  type ContinuousCloseDetectorPolicy,
} from "./continuous-close-config.ts";
import { absoluteUnits, moneyAbs, type WorkItemSeverity } from "./measure.ts";
import type { AgentFinding } from "./types.ts";
import { MODULE_BY_KEY } from "../navigation/nav-registry.ts";

/**
 * Evidence "open source" target, resolved through the nav registry — never a
 * hand-built path. A hand-built "/ar/cockpit" shipped here and 404d every
 * finding's source link (F-t11-012); the AR cockpit route is the registry's
 * `ar` entry. Resolving (not copying) keeps the link honest if the route
 * ever moves: a dropped key yields no link rather than a dead one, and the
 * drawer already hides non-string hrefs.
 */
function arCockpitHref(): string | undefined {
  return MODULE_BY_KEY.get("ar")?.href;
}

/**
 * Collections pack — overdue balances by customer with payment behaviour,
 * broken payment promises, and credit-hold candidates.
 *
 * Grouping mirrors the AR cockpit's per-customer projection
 * (`web/lib/cash/ar-position.ts` `byCustomer`: open items grouped by party,
 * most overdue first) and the open-item semantics of
 * `web/lib/cash/open-items.ts` (posted documents, unapplied credits net
 * against the party's balance). The engine cannot import web/ code, so the
 * pack re-expresses those exact predicates in engine-native SQL:
 * kind in ('customer_invoice','customer_credit'), status 'posted',
 * open_balance <> 0, overdue aged on due_date against the org business day.
 *
 * Every finding proposes nothing executable: no record-send tool exists, so
 * the overdue finding lists the reminder drafts inline (the shard's stated
 * fallback) and the findings set ordered by materiality IS the priority call
 * list. The pack never writes.
 */

export const COLLECTIONS_DETECTOR_KEYS = [
  "overdue_customer_balance",
  "broken_payment_promise",
  "credit_hold_candidate",
] as const;

export type OverdueCustomerRow = {
  partyId: string | null;
  partyName: string;
  email: string | null;
  openBalance: string;
  overdueBalance: string;
  overdueCount: number;
  openCount: number;
  oldestDue: string;
  latePayments: number;
  worstLateDays: number;
};

export type OverdueInvoiceRow = {
  partyId: string | null;
  docId: string;
  docNumber: string | null;
  dueDate: string;
  openBalance: string;
};

export type BrokenPromiseRow = {
  partyId: string | null;
  partyName: string;
  docId: string;
  docNumber: string | null;
  expectedPayDate: string;
  dueDate: string | null;
  openBalance: string;
};

export type CollectionsLoaders = {
  /** Org business day (business-date.ts); injectable so unit tests stay DB-free. */
  today: (orgId: string) => Promise<string>;
  overdueCustomers: (orgId: string, today: string) => Promise<OverdueCustomerRow[]>;
  overdueInvoices: (orgId: string, today: string, limitPerParty: number) => Promise<OverdueInvoiceRow[]>;
  brokenPromises: (orgId: string, cutoff: string) => Promise<BrokenPromiseRow[]>;
};

export function classifyCollectionSeverity(args: {
  materiality: string;
  threshold: string;
  oldestDate: string;
  now?: Date;
  criticalAgeDays?: number;
  criticalMaterialityMultiple?: number;
}): WorkItemSeverity {
  const ageDays = (() => {
    const date = Date.parse(`${args.oldestDate}T00:00:00Z`);
    if (!Number.isFinite(date)) return 0;
    const now = args.now ?? new Date();
    return Math.max(
      0,
      Math.floor(
        (Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - date) / 86_400_000,
      ),
    );
  })();
  const material = absoluteUnits(args.materiality);
  const threshold = absoluteUnits(args.threshold);
  if (
    ageDays >= (args.criticalAgeDays ?? 30) ||
    material >= threshold * BigInt(args.criticalMaterialityMultiple ?? 5)
  ) {
    return "critical";
  }
  return "warning";
}

export function qualifiesForCreditHold(args: {
  overdueBalance: string;
  threshold: string;
  oldestDue: string;
  overdueCount: number;
  now?: Date;
  holdOverdueDays: number;
  holdMaterialityMultiple: number;
  minOverdueInvoices: number;
}): boolean {
  const date = Date.parse(`${args.oldestDue}T00:00:00Z`);
  const now = args.now ?? new Date();
  const ageDays = Number.isFinite(date)
    ? Math.max(
        0,
        Math.floor(
          (Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - date) / 86_400_000,
        ),
      )
    : 0;
  return (
    ageDays >= args.holdOverdueDays &&
    absoluteUnits(args.overdueBalance) >= absoluteUnits(args.threshold) * BigInt(args.holdMaterialityMultiple) &&
    args.overdueCount >= args.minOverdueInvoices
  );
}

function reminderDraft(args: { partyName: string; overdueBalance: string; oldestDue: string; count: number }): string {
  return (
    `To: ${args.partyName} — Subject: Outstanding balance ${args.overdueBalance} ` +
    `(${args.count} overdue invoice${args.count === 1 ? "" : "s"}, oldest due ${args.oldestDue}). ` +
    `Body: a polite nudge stating the balance, the oldest due date, and payment instructions, ` +
    `sent after review. (Draft listed by the collections agent; no record-send tool exists to dispatch it.)`
  );
}

function partyKey(partyId: string | null): string {
  return partyId ?? "unassigned";
}

async function loadOverdueCustomers(orgId: string, today: string): Promise<OverdueCustomerRow[]> {
  const aggregates = (await db.execute<{
    party_id: string | null;
    party_name: string;
    email: string | null;
    open_balance: string;
    overdue_balance: string;
    overdue_count: number;
    open_count: number;
    oldest_due: string;
  }>(sql`
    select d.party_id,
           coalesce(p.display_name, 'Unspecified') as party_name,
           max(p.email) as email,
           sum(abs(d.open_balance))::text as open_balance,
           sum(abs(d.open_balance)) filter (where d.kind = 'customer_invoice' and d.due_date < ${today})::text as overdue_balance,
           count(*) filter (where d.kind = 'customer_invoice' and d.due_date < ${today})::int as overdue_count,
           count(*)::int as open_count,
           min(d.due_date) filter (where d.kind = 'customer_invoice' and d.due_date < ${today}) as oldest_due
      from documents d
      left join parties p on p.id = d.party_id and p.org_id = d.org_id
     where d.org_id = ${orgId}
       and d.kind in ('customer_invoice', 'customer_credit')
       and d.status = 'posted'
       and d.open_balance <> 0
     group by d.party_id, p.display_name
    having count(*) filter (where d.kind = 'customer_invoice' and d.due_date < ${today}) > 0
  `));
  const late = (await db.execute<{ party_id: string | null; late_count: number; worst_days: number }>(sql`
    select jl.party_id, count(*)::int as late_count,
           max(x.applied_on - jl.due_date)::int as worst_days
      from applications x
      join journal_lines jl on jl.org_id = x.org_id
        and (jl.id = x.from_line_id or jl.id = x.to_line_id)
      join accounts a on a.id = jl.account_id and a.org_id = jl.org_id and a.type = 'asset_receivable'
     where x.org_id = ${orgId}
       and jl.party_id is not null
       and jl.due_date is not null
       and x.applied_on > jl.due_date
     group by jl.party_id
  `));
  const lateByParty = new Map<string, { late_count: number; worst_days: number }>(
    late.rows.map((row) => [partyKey(row.party_id), { late_count: Number(row.late_count), worst_days: Number(row.worst_days) }]),
  );
  return aggregates.rows.map((row) => ({
    partyId: row.party_id,
    partyName: row.party_name,
    email: row.email,
    openBalance: moneyAbs(row.open_balance),
    overdueBalance: moneyAbs(row.overdue_balance),
    overdueCount: Number(row.overdue_count),
    openCount: Number(row.open_count),
    oldestDue: String(row.oldest_due),
    latePayments: lateByParty.get(partyKey(row.party_id))?.late_count ?? 0,
    worstLateDays: lateByParty.get(partyKey(row.party_id))?.worst_days ?? 0,
  }));
}

async function loadOverdueInvoices(orgId: string, today: string, limitPerParty: number): Promise<OverdueInvoiceRow[]> {
  const rows = (await db.execute<{
    party_id: string | null;
    doc_id: string;
    doc_number: string | null;
    due_date: string;
    open_balance: string;
  }>(sql`
    select party_id, doc_id, doc_number, due_date, open_balance from (
      select d.party_id,
             d.id as doc_id,
             d.document_number as doc_number,
             d.due_date::text as due_date,
             abs(d.open_balance)::text as open_balance,
             row_number() over (partition by d.party_id order by d.due_date, abs(d.open_balance) desc) as position
        from documents d
       where d.org_id = ${orgId}
         and d.kind = 'customer_invoice'
         and d.status = 'posted'
         and d.open_balance <> 0
         and d.due_date < ${today}
    ) ranked where position <= ${limitPerParty}
  `));
  return rows.rows.map((row) => ({
    partyId: row.party_id,
    docId: row.doc_id,
    docNumber: row.doc_number,
    dueDate: String(row.due_date),
    openBalance: moneyAbs(row.open_balance),
  }));
}

async function loadBrokenPromises(orgId: string, cutoff: string): Promise<BrokenPromiseRow[]> {
  const rows = (await db.execute<{
    party_id: string | null;
    party_name: string;
    doc_id: string;
    doc_number: string | null;
    expected_pay_date: string;
    due_date: string | null;
    open_balance: string;
  }>(sql`
    select d.party_id,
           coalesce(p.display_name, 'Unspecified') as party_name,
           d.id as doc_id,
           d.document_number as doc_number,
           d.expected_pay_date::text as expected_pay_date,
           d.due_date::text as due_date,
           abs(d.open_balance)::text as open_balance
      from documents d
      left join parties p on p.id = d.party_id and p.org_id = d.org_id
     where d.org_id = ${orgId}
       and d.kind = 'customer_invoice'
       and d.status = 'posted'
       and d.open_balance <> 0
       and d.expected_pay_date is not null
       and d.expected_pay_date <= ${cutoff}
     order by d.expected_pay_date, abs(d.open_balance) desc
     limit 200
  `));
  return rows.rows.map((row) => ({
    partyId: row.party_id,
    partyName: row.party_name,
    docId: row.doc_id,
    docNumber: row.doc_number,
    expectedPayDate: String(row.expected_pay_date),
    dueDate: row.due_date === null ? null : String(row.due_date),
    openBalance: moneyAbs(row.open_balance),
  }));
}

export const productionCollectionsLoaders: CollectionsLoaders = {
  today: businessToday,
  overdueCustomers: loadOverdueCustomers,
  overdueInvoices: loadOverdueInvoices,
  brokenPromises: loadBrokenPromises,
};

function addCalendarDaysIso(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export async function collectionsFindings(
  orgId: string,
  agentThreshold: string,
  detectors: ContinuousCloseDetectorPolicy[],
  loaders: CollectionsLoaders = productionCollectionsLoaders,
): Promise<AgentFinding[]> {
  if (!detectors.some((detector) => detector.enabled && (COLLECTIONS_DETECTOR_KEYS as readonly string[]).includes(detector.detectorKey))) {
    return [];
  }
  const today = await loaders.today(orgId);
  const findings: AgentFinding[] = [];
  const byKey = new Map(detectors.map((detector) => [detector.detectorKey, detector]));

  const overduePolicy = byKey.get("overdue_customer_balance");
  const holdPolicy = byKey.get("credit_hold_candidate");
  if (overduePolicy?.enabled || holdPolicy?.enabled) {
    const customers = await loaders.overdueCustomers(orgId, today);
    const invoices = overduePolicy?.enabled ? await loaders.overdueInvoices(orgId, today, 5) : [];
    const invoicesByParty = new Map<string, OverdueInvoiceRow[]>();
    for (const invoice of invoices) {
      const list = invoicesByParty.get(partyKey(invoice.partyId)) ?? [];
      list.push(invoice);
      invoicesByParty.set(partyKey(invoice.partyId), list);
    }
    const overdueThreshold = overduePolicy?.enabled
      ? absoluteUnits(effectiveDetectorMateriality(overduePolicy, agentThreshold))
      : null;
    const ranked = customers
      .filter((customer) => overdueThreshold !== null && absoluteUnits(customer.overdueBalance) >= overdueThreshold)
      .sort((a, b) => {
        const diff = toUnits(b.overdueBalance) - toUnits(a.overdueBalance);
        return diff === 0n ? 0 : diff > 0n ? 1 : -1;
      });
    const rankedKeys = new Set(ranked.map((customer) => partyKey(customer.partyId)));
    for (const customer of customers) {
      if (overduePolicy?.enabled && rankedKeys.has(partyKey(customer.partyId))) {
        const threshold = effectiveDetectorMateriality(overduePolicy, agentThreshold);
        {
          const index = ranked.findIndex((entry) => partyKey(entry.partyId) === partyKey(customer.partyId));
          const partyInvoices = invoicesByParty.get(partyKey(customer.partyId)) ?? [];
          findings.push({
            agentKey: "collections",
            findingType: "overdue_customer_balance",
            fingerprint: `collections-overdue:${partyKey(customer.partyId)}`,
            severity: classifyCollectionSeverity({
              materiality: customer.overdueBalance,
              threshold,
              oldestDate: customer.oldestDue,
              criticalAgeDays: overduePolicy.parameters.criticalAgeDays,
              criticalMaterialityMultiple: overduePolicy.parameters.criticalMaterialityMultiple,
            }),
            confidence: "1.0000",
            materiality: customer.overdueBalance,
            subjectType: "party",
            subjectId: customer.partyId,
            summary: {
              partyName: customer.partyName,
              openBalance: customer.openBalance,
              overdueBalance: customer.overdueBalance,
              overdueCount: customer.overdueCount,
              openCount: customer.openCount,
              oldestDue: customer.oldestDue,
              latePayments: customer.latePayments,
              worstLateDays: customer.worstLateDays,
              callPriority: index + 1,
              callListSize: ranked.length,
              reminderDraft: reminderDraft({
                partyName: customer.partyName,
                overdueBalance: customer.overdueBalance,
                oldestDue: customer.oldestDue,
                count: customer.overdueCount,
              }),
              href: arCockpitHref(),
            },
            evidence: [
              ...partyInvoices.map((invoice) => ({
                kind: "overdue_invoice",
                sourceType: "document",
                sourceId: invoice.docId,
                data: {
                  documentNumber: invoice.docNumber,
                  dueDate: invoice.dueDate,
                  openBalance: invoice.openBalance,
                },
              })),
              ...(customer.latePayments > 0
                ? [
                    {
                      kind: "payment_behaviour",
                      sourceType: null,
                      sourceId: null,
                      data: {
                        latePayments: customer.latePayments,
                        worstLateDays: customer.worstLateDays,
                      },
                    },
                  ]
                : []),
            ],
          });
        }
      }
      if (holdPolicy?.enabled) {
        const threshold = effectiveDetectorMateriality(holdPolicy, agentThreshold);
        if (
          qualifiesForCreditHold({
            overdueBalance: customer.overdueBalance,
            threshold,
            oldestDue: customer.oldestDue,
            overdueCount: customer.overdueCount,
            holdOverdueDays: holdPolicy.parameters.holdOverdueDays!,
            holdMaterialityMultiple: holdPolicy.parameters.holdMaterialityMultiple!,
            minOverdueInvoices: holdPolicy.parameters.minOverdueInvoices!,
          })
        ) {
          findings.push({
            agentKey: "collections",
            findingType: "credit_hold_candidate",
            fingerprint: `collections-credit-hold:${partyKey(customer.partyId)}`,
            severity: "warning",
            confidence: "1.0000",
            materiality: customer.overdueBalance,
            subjectType: "party",
            subjectId: customer.partyId,
            summary: {
              partyName: customer.partyName,
              overdueBalance: customer.overdueBalance,
              overdueCount: customer.overdueCount,
              oldestDue: customer.oldestDue,
              latePayments: customer.latePayments,
              worstLateDays: customer.worstLateDays,
              review: "Place on credit hold and require prepayment on new orders until the arrears clear.",
              href: arCockpitHref(),
            },
            evidence: [
              {
                kind: "credit_hold_case",
                sourceType: "party",
                sourceId: customer.partyId,
                data: {
                  overdueBalance: customer.overdueBalance,
                  overdueCount: customer.overdueCount,
                  oldestDue: customer.oldestDue,
                  latePayments: customer.latePayments,
                  worstLateDays: customer.worstLateDays,
                },
              },
            ],
          });
        }
      }
    }
  }

  const promisePolicy = byKey.get("broken_payment_promise");
  if (promisePolicy?.enabled) {
    const threshold = effectiveDetectorMateriality(promisePolicy, agentThreshold);
    const cutoff = addCalendarDaysIso(today, -(promisePolicy.parameters.breachToleranceDays ?? 3));
    const rows = await loaders.brokenPromises(orgId, cutoff);
    const byParty = new Map<string, BrokenPromiseRow[]>();
    for (const row of rows) {
      const list = byParty.get(partyKey(row.partyId)) ?? [];
      list.push(row);
      byParty.set(partyKey(row.partyId), list);
    }
    for (const [key, docs] of byParty) {
      const total = docs.reduce((sum, doc) => sum + toUnits(doc.openBalance), 0n);
      if (total < absoluteUnits(threshold)) continue;
      const oldest = docs.map((doc) => doc.expectedPayDate).sort()[0]!;
      const materiality = fromUnits(docs.reduce((sum, doc) => sum + toUnits(doc.openBalance), 0n));
      findings.push({
        agentKey: "collections",
        findingType: "broken_payment_promise",
        fingerprint: `collections-promise:${key}`,
        severity: classifyCollectionSeverity({
          materiality,
          threshold,
          oldestDate: oldest,
          criticalAgeDays: promisePolicy.parameters.criticalAgeDays,
          criticalMaterialityMultiple: promisePolicy.parameters.criticalMaterialityMultiple,
        }),
        confidence: "1.0000",
        materiality,
        subjectType: "party",
        subjectId: docs[0]!.partyId,
        summary: {
          partyName: docs[0]!.partyName,
          brokenCount: docs.length,
          oldestExpectedPayDate: oldest,
          href: arCockpitHref(),
        },
        evidence: docs.slice(0, 10).map((doc) => ({
          kind: "broken_promise",
          sourceType: "document",
          sourceId: doc.docId,
          data: {
            documentNumber: doc.docNumber,
            expectedPayDate: doc.expectedPayDate,
            dueDate: doc.dueDate,
            openBalance: doc.openBalance,
          },
        })),
      });
    }
  }

  return findings;
}

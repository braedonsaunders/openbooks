import { sql } from "drizzle-orm";
import { allocateDocumentNumber } from "../records/numbering.ts";
import { loadRequiredControlAccounts } from "../records/control-accounts.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { submitAndReleaseIfUngated } from "../flows/submit.ts";
import { lockAndCheckOrgFeature, orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import { uuidArray } from "../organization/subsidiaries.ts";
import { businessToday } from "../platform/business-date.ts";
import { addCalendarDays, daysInCivilMonth, mondayOfIsoWeek } from "../platform/civil-date.ts";
import { db, orgContext, withBypass, withOrg, type SqlExecutor } from "../platform/db.ts";

/**
 * Payer hierarchies and consolidated billing. A subscription's service-to
 * party (who uses it) need not be its bill-to party (who receives the
 * invoice) or its payer (whose AR it is): a parent company pays for its
 * subsidiaries, a reseller is billed for its end customers, a franchise
 * takes one monthly invoice for forty locations. Subscription billing and
 * usage rating resolve the effective parties on the billing date; a
 * consolidation run then rolls one group's draft charges into a single
 * invoice per payer per currency, superseding the drafts with links — never
 * deleting them. Cross-entity charges keep their service entity on the line
 * so the ledger kernel posts the intercompany pair (and refuses by name when
 * no pair is configured). Gated by the org's `consolidatedBilling` feature:
 * with the gate off every subscription bills its own customer, byte for
 * byte as before.
 */

export class ConsolidatedBillingError extends Error {
  constructor(message: string, readonly status = 422) {
    super(message);
    this.name = "ConsolidatedBillingError";
  }
}

const FEATURE_REMEDY = "Turn on Consolidated billing under Company Settings → Features, then retry.";

export type ConsolidationGrouping = "by_child" | "by_subscription" | "by_product";

export interface SubscriptionPartyOverride {
  billToPartyId: string | null;
  payerPartyId: string | null;
}

/** Who a charge bills through, pinned on the billing date. */
export interface EffectiveBillingParties {
  servicePartyId: string;
  billToPartyId: string;
  payerPartyId: string;
  /** The consolidation group holding this charge, or null when it bills standalone. */
  consolidationGroupId: string | null;
}

export type ConsolidationGroup = {
  id: string;
  code: string;
  name: string;
  payerPartyId: string;
  billingSubsidiaryId: string | null;
  cadence: "weekly" | "monthly";
  cutoffDay: number;
  grouping: ConsolidationGrouping;
  template: string | null;
  isActive: boolean;
};

const IDENTITY = (servicePartyId: string): EffectiveBillingParties => ({
  servicePartyId,
  billToPartyId: servicePartyId,
  payerPartyId: servicePartyId,
  consolidationGroupId: null,
});

/**
 * Resolve who a service-to party's charge bills through on `billingDate`.
 * Field precedence is subscription override, then the effective-dated
 * hierarchy relationship, then self-billing. A relationship's consolidation
 * group travels only with its own payer: a subscription override redirecting
 * the charge to another payer must not drag the old group along, so the
 * group applies only when it is active and names the resolved payer.
 * Overlapping relationship windows are refused at the write path; if they
 * ever occur, the latest effective row wins deterministically.
 */
export async function resolveEffectiveBillingParties(
  orgId: string,
  servicePartyId: string,
  billingDate: string,
  override: SubscriptionPartyOverride | null = null,
): Promise<EffectiveBillingParties> {
  if (!(await orgFeatureEnabled(orgId, "consolidatedBilling"))) return IDENTITY(servicePartyId);
  const service = (await db.execute<{ id: string }>(sql`
    select id from parties where org_id = ${orgId} and id = ${servicePartyId}
  `)).rows[0];
  if (!service) {
    throw new ConsolidatedBillingError(
      `customer ${servicePartyId} does not belong to this organization — bill the subscription from a customer of this organization`,
    );
  }
  const rel = (await db.execute<{
    billToPartyId: string;
    payerPartyId: string;
    groupId: string | null;
  }>(sql`
    select bill_to_party_id as "billToPartyId", payer_party_id as "payerPartyId",
           consolidation_group_id as "groupId"
      from customer_billing_relationships
     where org_id = ${orgId} and child_party_id = ${servicePartyId}
       and effective_from <= ${billingDate}
       and (effective_to is null or effective_to >= ${billingDate})
     order by effective_from desc, id desc
     limit 1
  `)).rows[0];
  const billToPartyId = override?.billToPartyId ?? rel?.billToPartyId ?? servicePartyId;
  const payerPartyId = override?.payerPartyId ?? rel?.payerPartyId ?? servicePartyId;
  for (const [role, partyId] of [["bill-to", billToPartyId], ["payer", payerPartyId]] as const) {
    const party = (await db.execute<{ id: string }>(sql`
      select id from parties where org_id = ${orgId} and id = ${partyId}
    `)).rows[0];
    if (!party) {
      throw new ConsolidatedBillingError(
        `the ${role} party ${partyId} does not belong to this organization — point the billing relationship at a party of this organization before billing`,
      );
    }
  }
  let consolidationGroupId: string | null = null;
  if (rel?.groupId) {
    const group = (await db.execute<{ id: string; payerPartyId: string; isActive: boolean }>(sql`
      select id, payer_party_id as "payerPartyId", is_active as "isActive"
        from consolidation_groups where org_id = ${orgId} and id = ${rel.groupId}
    `)).rows[0];
    if (group?.isActive && group.payerPartyId === payerPartyId) consolidationGroupId = group.id;
  }
  return { servicePartyId, billToPartyId, payerPartyId, consolidationGroupId };
}

/** Load one consolidation group with its billing configuration. */
export async function loadConsolidationGroup(
  orgId: string,
  groupId: string,
  runner: SqlExecutor = db,
): Promise<ConsolidationGroup> {
  const group = (await runner.execute<ConsolidationGroup>(sql`
    select id, code, name, payer_party_id as "payerPartyId",
           billing_subsidiary_id as "billingSubsidiaryId", cadence,
           cutoff_day as "cutoffDay", grouping, template, is_active as "isActive"
      from consolidation_groups where org_id = ${orgId} and id = ${groupId}
  `)).rows[0];
  if (!group) {
    throw new ConsolidatedBillingError(
      `consolidation group ${groupId} does not exist in this organization — choose a group from the consolidation setup before running`,
    );
  }
  return group;
}

/**
 * The consolidation bucket a charge date falls in. Monthly buckets run
 * cut-off to cut-off (cutoff_day 3: Jan 3 → Feb 2); weekly buckets are the
 * seven days starting on the cut-off weekday (1 = Monday). Pure.
 */
export function consolidationPeriodFor(
  group: Pick<ConsolidationGroup, "cadence" | "cutoffDay">,
  invoiceDate: string,
): { periodStart: string; periodEnd: string } {
  const [yRaw, mRaw, dRaw] = invoiceDate.split("-").map(Number);
  if (
    !Number.isSafeInteger(yRaw) || !Number.isSafeInteger(mRaw) || !Number.isSafeInteger(dRaw) ||
    mRaw! < 1 || mRaw! > 12 || dRaw! < 1 || dRaw! > daysInCivilMonth(yRaw!, mRaw!)
  ) {
    throw new ConsolidatedBillingError(`cannot place ${invoiceDate} in a consolidation period — bill with a valid ISO date`);
  }
  const y = yRaw!;
  const m = mRaw!;
  const d = dRaw!;
  if (group.cadence === "weekly") {
    const weekday = ((group.cutoffDay - 1) % 7) + 1;
    const monday = mondayOfIsoWeek(invoiceDate);
    let start = addCalendarDays(monday, weekday - 1);
    if (start > invoiceDate) start = addCalendarDays(start, -7);
    return { periodStart: start, periodEnd: addCalendarDays(start, 6) };
  }
  const pad = (n: number): string => String(n).padStart(2, "0");
  const at = (year: number, month: number): string => `${String(year).padStart(4, "0")}-${pad(month)}-${pad(group.cutoffDay)}`;
  const prev = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
  const next = m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
  if (d >= group.cutoffDay) return { periodStart: at(y, m), periodEnd: addCalendarDays(at(next.y, next.m), -1) };
  return { periodStart: at(prev.y, prev.m), periodEnd: addCalendarDays(at(y, m), -1) };
}

/**
 * Resolve the entities a consolidated charge posts to. The billing entity is
 * the group's explicit billing subsidiary, else the payer's own entity (an
 * org-wide payer falls back to the root); the service entity is the service
 * customer's own entity with the same fallback. Either side refuses by name
 * instead of posting to an entity it cannot trust — mirroring the
 * subscription engine's own customer-entity refusal.
 */
export async function resolveConsolidationEntities(
  orgId: string,
  group: Pick<ConsolidationGroup, "billingSubsidiaryId"> & { code?: string },
  servicePartyId: string,
  payerPartyId: string,
): Promise<{ billingSubsidiaryId: string; serviceSubsidiaryId: string }> {
  const parties = (await db.execute<{ id: string; subsidiaryId: string | null; trustedSubsidiaryId: string | null }>(sql`
    select p.id, p.subsidiary_id as "subsidiaryId",
           (select s.id from subsidiaries s
             where s.id = p.subsidiary_id and s.org_id = ${orgId} and s.is_active) as "trustedSubsidiaryId"
      from parties p where p.org_id = ${orgId} and p.id in (${servicePartyId}, ${payerPartyId})
  `)).rows;
  const byId = new Map(parties.map((p) => [p.id, p]));
  const service = byId.get(servicePartyId);
  const payer = byId.get(payerPartyId);
  if (!service || !payer) {
    throw new ConsolidatedBillingError(
      "a consolidation party left this organization mid-run — reload the consolidation group and retry",
    );
  }
  if (service.subsidiaryId !== null && service.trustedSubsidiaryId === null) {
    throw new ConsolidatedBillingError(
      "the service customer is assigned to a subsidiary that is not active in this organization — " +
      "reassign the customer to an active subsidiary (or clear the assignment for an org-wide customer) before consolidating",
    );
  }
  const rootId = (await db.execute<{ id: string }>(sql`
    select id from subsidiaries where org_id = ${orgId} and parent_id is null limit 1
  `)).rows[0]?.id;
  if (group.billingSubsidiaryId) {
    const billing = (await db.execute<{ id: string }>(sql`
      select id from subsidiaries where org_id = ${orgId} and id = ${group.billingSubsidiaryId} and is_active
    `)).rows[0];
    if (!billing) {
      throw new ConsolidatedBillingError(
        `consolidation group "${group.code ?? group.billingSubsidiaryId}" bills through a subsidiary that is not active in this organization — ` +
        "point the group at an active billing subsidiary under the consolidation setup before running",
      );
    }
    if (!rootId) throw new ConsolidatedBillingError("this organization has no root subsidiary — create the entity structure before consolidating");
    return { billingSubsidiaryId: billing.id, serviceSubsidiaryId: service.trustedSubsidiaryId ?? rootId };
  }
  if (payer.subsidiaryId !== null && payer.trustedSubsidiaryId === null) {
    throw new ConsolidatedBillingError(
      "the payer is assigned to a subsidiary that is not active in this organization — " +
      "reassign the payer to an active subsidiary (or clear the assignment for an org-wide payer) before consolidating",
    );
  }
  if (!rootId) throw new ConsolidatedBillingError("this organization has no root subsidiary — create the entity structure before consolidating");
  return {
    billingSubsidiaryId: payer.trustedSubsidiaryId ?? rootId,
    serviceSubsidiaryId: service.trustedSubsidiaryId ?? rootId,
  };
}

/**
 * Everything one subscription or usage charge needs to bill through the
 * hierarchy: the AR payer, the bill-to recipient, the service party for the
 * lines, the header and line entities, and — when a group holds the charge —
 * the pending-consolidation marker that keeps the draft unposted.
 */
export interface SubscriptionBillingTarget {
  payerPartyId: string;
  billToPartyId: string;
  servicePartyId: string;
  /**
   * The invoice header entity. A group-held draft keeps the service entity
   * (the standalone invoice it would have been, only redirected to the
   * payer and held unposted); a directly-billed charge carries the payer's
   * billing entity as its AR home.
   */
  headerSubsidiaryId: string;
  /**
   * The lines' entity when it differs from the header (cross-entity charges
   * outside a group, whose header already sits in the billing entity).
   * Group-held drafts leave this null: their lines default to the service
   * entity on the header, and the run re-splits them under the payer's
   * billing entity at consolidation time.
   */
  lineSubsidiaryId: string | null;
  consolidation: { groupId: string; periodStart: string; periodEnd: string } | null;
}

/**
 * Resolve one charge's hierarchy target on its billing date. Without a
 * relationship (or with the feature off) the target is the service customer
 * itself and every invoice path below behaves exactly as before.
 */
export async function resolveSubscriptionBillingTarget(
  orgId: string,
  serviceCustomerId: string,
  billingDate: string,
  override: SubscriptionPartyOverride | null,
): Promise<SubscriptionBillingTarget> {
  const parties = await resolveEffectiveBillingParties(orgId, serviceCustomerId, billingDate, override);
  if (!parties.consolidationGroupId) {
    const entities = await resolveConsolidationEntities(
      orgId,
      { billingSubsidiaryId: null },
      parties.servicePartyId,
      parties.payerPartyId,
    );
    return {
      payerPartyId: parties.payerPartyId,
      billToPartyId: parties.billToPartyId,
      servicePartyId: parties.servicePartyId,
      headerSubsidiaryId: entities.billingSubsidiaryId,
      lineSubsidiaryId:
        entities.serviceSubsidiaryId !== entities.billingSubsidiaryId ? entities.serviceSubsidiaryId : null,
      consolidation: null,
    };
  }
  const group = await loadConsolidationGroup(orgId, parties.consolidationGroupId);
  // Validates the payer and the group's billing entity now (fail fast at
  // billing time, not at the run) and resolves the service entity the draft
  // header keeps.
  const entities = await resolveConsolidationEntities(orgId, group, parties.servicePartyId, parties.payerPartyId);
  const period = consolidationPeriodFor(group, billingDate);
  return {
    payerPartyId: parties.payerPartyId,
    billToPartyId: parties.billToPartyId,
    servicePartyId: parties.servicePartyId,
    headerSubsidiaryId: entities.serviceSubsidiaryId,
    lineSubsidiaryId: null,
    consolidation: { groupId: group.id, periodStart: period.periodStart, periodEnd: period.periodEnd },
  };
}

type PriorRun = { runId: string; invoiceId: string; documentNumber: string; currency: string };

/**
 * Replay committed consolidation invoices instead of cutting second invoices: the
 * superseded drafts and their links are re-read so the replay names the same
 * invoice and drafts. A guard pointing at a missing invoice refuses — the
 * books must be restored before anything replays.
 */
async function replayConsolidationRuns(
  orgId: string,
  groupId: string,
  periodStart: string,
  periodEnd: string,
  billingSubsidiaryId: string,
  priorRuns: PriorRun[],
): Promise<ConsolidationRunResult[]> {
  const results: ConsolidationRunResult[] = [];
  for (const guard of priorRuns) {
    const superseded = (await db.execute<{ id: string }>(sql`
      select l.from_document_id as id from document_links l
       where l.org_id = ${orgId} and l.to_document_id = ${guard.invoiceId} and l.link_type = 'created_from'
    `)).rows.map((row) => row.id);
    const totals = (await db.execute<{ subtotal: string; taxTotal: string; total: string }>(sql`
      select subtotal::text as subtotal, tax_total::text as "taxTotal", total::text as total
        from documents where org_id = ${orgId} and id = ${guard.invoiceId}
    `)).rows[0];
    if (!totals) {
      throw new ConsolidatedBillingError(
        `consolidation for ${periodStart} through ${periodEnd} points to a missing invoice — restore the invoice record before re-running`,
      );
    }
    results.push({
      runId: guard.runId,
      groupId,
      periodStart,
      periodEnd,
      currency: guard.currency,
      billingSubsidiaryId,
      invoiceId: guard.invoiceId,
      documentNumber: guard.documentNumber,
      posted: false,
      supersededDraftIds: superseded,
      ...totals,
      replayed: true,
    });
  }
  return results;
}

export interface ConsolidationRunOptions {
  actorId?: string | null;
  /** Post each consolidated invoice through approval/posting instead of leaving it draft. */
  autoPost?: boolean;
}

export interface ConsolidationRunResult {
  runId: string;
  groupId: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  billingSubsidiaryId: string;
  invoiceId: string;
  documentNumber: string;
  posted: boolean;
  supersededDraftIds: string[];
  subtotal: string;
  taxTotal: string;
  total: string;
  /** True when the bucket was already consolidated and the committed invoice is replayed. */
  replayed: boolean;
}

type PendingDraft = {
  id: string;
  documentNumber: string;
  documentDate: string;
  currency: string;
  subsidiaryId: string | null;
  partyId: string;
  subtotal: string;
  taxTotal: string;
  total: string;
  billToPartyId: string | null;
  subscriptionId: string | null;
};

type PendingLine = {
  id: string;
  documentId: string;
  lineNumber: number;
  itemId: string | null;
  accountId: string;
  description: string | null;
  quantity: string;
  unitPrice: string;
  amount: string;
  taxCodeId: string | null;
  taxAmount: string;
  servicePartyId: string | null;
  serviceName: string | null;
  subscriptionId: string | null;
  custom: Record<string, unknown> | null;
};

function orderLines(lines: PendingLine[], grouping: ConsolidationGrouping): PendingLine[] {
  const keyOf = (line: PendingLine): string => {
    if (grouping === "by_product") return line.itemId ?? "";
    if (grouping === "by_subscription") return line.subscriptionId ?? "";
    return line.servicePartyId ?? "";
  };
  const nameOf = (line: PendingLine): string => {
    if (grouping === "by_product") return line.description ?? "";
    if (grouping === "by_subscription") return line.subscriptionId ?? "";
    return line.serviceName ?? "";
  };
  // Group ranks come from a first pass in input order: assigning them inside
  // the comparator would follow the sorter's comparison sequence, not the
  // billing sequence, and scramble groups.
  const rank = new Map<string, number>();
  for (const line of lines) {
    const key = keyOf(line);
    if (!rank.has(key)) rank.set(key, rank.size);
  }
  return [...lines].sort((a, b) => {
    const groupOrder = rank.get(keyOf(a))! - rank.get(keyOf(b))!;
    if (groupOrder !== 0) return groupOrder;
    if (nameOf(a) !== nameOf(b)) return nameOf(a) < nameOf(b) ? -1 : 1;
    return a.lineNumber - b.lineNumber;
  });
}

/**
 * Consolidate one group's pending drafts for [periodStart, periodEnd] into
 * one invoice per payer per currency. Drafts stay draft and are superseded
 * with document links — never deleted, never posted by the run. A re-run of
 * an already-consolidated bucket replays the committed invoice. Every
 * collected draft must still be draft and addressed to the group's payer;
 * anything else refuses by name instead of consolidating around it.
 */
export async function runConsolidationGroup(
  orgId: string,
  groupId: string,
  periodStart: string,
  periodEnd: string,
  opts: ConsolidationRunOptions = {},
): Promise<ConsolidationRunResult[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(periodStart) || !/^\d{4}-\d{2}-\d{2}$/.test(periodEnd)) {
    throw new ConsolidatedBillingError("consolidation period bounds must be valid ISO dates");
  }
  if (periodEnd < periodStart) {
    throw new ConsolidatedBillingError(
      `consolidation period end ${periodEnd} precedes start ${periodStart} — run with an end on or after the start`,
    );
  }
  const actorId = opts.actorId ?? null;
  return withOrg(orgId, async () => {
    if (!(await lockAndCheckOrgFeature(db, orgId, "consolidatedBilling"))) {
      throw new ConsolidatedBillingError(`Consolidated billing is turned off for this organization. ${FEATURE_REMEDY}`);
    }
    const lockKey = `consolidation:${orgId}:${groupId}:${periodStart}:${periodEnd}`;
    await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
    const group = await loadConsolidationGroup(orgId, groupId);
    if (!group.isActive) {
      throw new ConsolidatedBillingError(
        `consolidation group "${group.code}" is inactive — reactivate the group under the consolidation setup before running`,
      );
    }
    const { billingSubsidiaryId } = await resolveConsolidationEntities(orgId, group, group.payerPartyId, group.payerPartyId);

    const priorRuns = (await db.execute<{ runId: string; invoiceId: string; documentNumber: string; currency: string }>(sql`
      select r.id as "runId", r.invoice_id as "invoiceId", d.document_number as "documentNumber", r.currency
        from consolidation_runs r join documents d on d.org_id = r.org_id and d.id = r.invoice_id
       where r.org_id = ${orgId} and r.group_id = ${groupId}
         and r.period_start = ${periodStart}::date and r.period_end = ${periodEnd}::date
         and r.billing_subsidiary_id = ${billingSubsidiaryId}
       order by r.currency
    `)).rows;
    const drafts = (await db.execute<PendingDraft>(sql`
      select d.id, d.document_number as "documentNumber", d.document_date::text as "documentDate",
             d.currency, d.subsidiary_id as "subsidiaryId", d.party_id as "partyId",
             d.subtotal::text as subtotal, d.tax_total::text as "taxTotal", d.total::text as total,
             nullif(d.custom->>'billToPartyId', '') as "billToPartyId",
             nullif(d.custom->>'subscriptionId', '') as "subscriptionId"
        from documents d
       where d.org_id = ${orgId} and d.kind = 'customer_invoice' and d.status = 'draft'
         and d.custom->>'consolidationStatus' = 'pending_consolidation'
         and d.custom->>'consolidationGroupId' = ${groupId}
         and d.document_date >= ${periodStart}::date and d.document_date <= ${periodEnd}::date
       order by d.document_date, d.document_number
    `)).rows;
    if (!drafts.length) {
      if (!priorRuns.length) {
        throw new ConsolidatedBillingError(
          `consolidation group "${group.code}" has no pending charges for ${periodStart} through ${periodEnd} — ` +
          "bill the grouped subscriptions first (their invoices collect here as pending drafts), then run again",
        );
      }
      // A completed bucket holds no pending drafts — the drafts were
      // superseded by the run itself. Replay every committed invoice.
      return replayConsolidationRuns(orgId, groupId, periodStart, periodEnd, billingSubsidiaryId, priorRuns);
    }
    for (const draft of drafts) {
      if (draft.partyId !== group.payerPartyId) {
        throw new ConsolidatedBillingError(
          `invoice ${draft.documentNumber} is addressed to another payer — ` +
          "move it to this group's payer or bill it standalone before consolidating this period",
        );
      }
    }

    const byCurrency = new Map<string, PendingDraft[]>();
    for (const draft of drafts) {
      const bucket = byCurrency.get(draft.currency);
      if (bucket) bucket.push(draft);
      else byCurrency.set(draft.currency, [draft]);
    }

    const guarded = new Map(priorRuns.map((run) => [run.currency, run]));
    const results: ConsolidationRunResult[] = [];
    for (const [currency, bucket] of [...byCurrency.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const guard = guarded.get(currency);
      if (guard) {
        results.push(
          ...(await replayConsolidationRuns(orgId, groupId, periodStart, periodEnd, billingSubsidiaryId, [guard])),
        );
        continue;
      }

      const draftIds = bucket.map((d) => d.id);
      const lines = (await db.execute<PendingLine>(sql`
        select l.id, l.document_id as "documentId", l.line_number as "lineNumber",
               l.item_id as "itemId", l.account_id as "accountId", l.description,
               l.quantity::text as quantity, l.unit_price::text as "unitPrice",
               l.amount::text as amount, l.tax_code_id as "taxCodeId",
               l.tax_amount::text as "taxAmount", l.service_party_id as "servicePartyId",
               p.display_name as "serviceName", d.custom->>'subscriptionId' as "subscriptionId",
               l.custom as custom
          from document_lines l
          join documents d on d.org_id = l.org_id and d.id = l.document_id
          left join parties p on p.org_id = l.org_id and p.id = l.service_party_id
         where l.org_id = ${orgId} and l.document_id = any(${uuidArray(draftIds)}::uuid[])
         order by l.document_id, l.line_number
      `)).rows;
      const missing = bucket.filter((d) => !lines.some((l) => l.documentId === d.id));
      if (missing.length) {
        throw new ConsolidatedBillingError(
          `invoice ${missing[0]!.documentNumber} has no lines to consolidate — void the empty draft before running`,
        );
      }
      const unserviced = lines.filter((l) => !l.servicePartyId);
      if (unserviced.length) {
        const draftNo = bucket.find((d) => d.id === unserviced[0]!.documentId)?.documentNumber ?? unserviced[0]!.documentId;
        throw new ConsolidatedBillingError(
          `invoice ${draftNo} has lines without a service party — re-bill those charges through a payer hierarchy relationship before consolidating`,
        );
      }
      // Drafts collect in (date, number) order; lines enter grouping in that
      // same draft order so by_child follows the billing sequence instead of
      // UUID order. orderLines then groups stably (first-seen group wins).
      const draftPosition = new Map(draftIds.map((id, index) => [id, index]));
      const inDraftOrder = [...lines].sort(
        (a, b) => draftPosition.get(a.documentId)! - draftPosition.get(b.documentId)! || a.lineNumber - b.lineNumber,
      );
      const ordered = orderLines(inDraftOrder, group.grouping);

      const sums = (await db.execute<{ subtotal: string; taxTotal: string; total: string }>(sql`
        select sum(amount)::text as subtotal, sum(tax_amount)::text as "taxTotal",
               sum(amount + tax_amount)::text as total
          from document_lines where org_id = ${orgId} and document_id = any(${uuidArray(draftIds)}::uuid[])
      `)).rows[0];
      if (!sums?.subtotal || !sums.taxTotal || !sums.total) {
        throw new ConsolidatedBillingError(
          `could not total the pending charges for ${periodStart} through ${periodEnd} — reload the drafts and retry`,
        );
      }

      const billToPartyId = bucket[0]!.billToPartyId ?? group.payerPartyId;
      const documentNumber = await allocateDocumentNumber(db, orgId, "customer_invoice", "INV-");
      const created = (await db.execute<{ id: string }>(sql`
        insert into documents (org_id, kind, document_number, party_id, document_date, due_date, currency, status,
                               subsidiary_id, memo, subtotal, tax_total, total, custom, created_by)
        values (${orgId}, 'customer_invoice', ${documentNumber}, ${group.payerPartyId}, ${periodEnd},
                null, ${currency}, 'draft', ${billingSubsidiaryId},
                ${`Consolidated billing — ${group.name} (${periodStart} → ${periodEnd})`},
                ${sums.subtotal}, ${sums.taxTotal}, ${sums.total},
                ${JSON.stringify({
                  consolidationGroupId: groupId,
                  consolidationPeriodStart: periodStart,
                  consolidationPeriodEnd: periodEnd,
                  consolidationStatus: "consolidated",
                  billToPartyId,
                  payerPartyId: group.payerPartyId,
                  sourceDraftIds: draftIds,
                })}::jsonb, ${actorId})
        returning id
      `));
      const invoiceId = created.rows[0]!.id;

      const draftSubsidiary = new Map(bucket.map((d) => [d.id, d.subsidiaryId]));
      let lineNumber = 0;
      for (const line of ordered) {
        lineNumber += 1;
        // A line earned by another entity keeps that entity: the kernel
        // balances the difference with intercompany due-to/due-from legs at
        // posting time (refusing by name when no pair is configured). Same
        // entity stays null and defaults to the header, exactly as before.
        const serviceSubsidiary = draftSubsidiary.get(line.documentId) ?? null;
        const lineSubsidiary = serviceSubsidiary && serviceSubsidiary !== billingSubsidiaryId ? serviceSubsidiary : null;
        const inserted = (await db.execute<{ id: string }>(sql`
          insert into document_lines (org_id, document_id, line_number, item_id, account_id, description, quantity,
                unit_price, amount, tax_code_id, tax_amount, subsidiary_id, party_id, service_party_id, custom, is_billable, created_by)
          values (${orgId}, ${invoiceId}, ${lineNumber}, ${line.itemId}, ${line.accountId},
                ${line.description}, ${line.quantity}, ${line.unitPrice}, ${line.amount},
                ${line.taxCodeId}, ${line.taxAmount}, ${lineSubsidiary}, ${line.servicePartyId}, ${line.servicePartyId},
                ${JSON.stringify(line.custom ?? {})}::jsonb, true, ${actorId})
          returning id
        `));
        const newLineId = inserted.rows[0]!.id;
        await db.execute(sql`
          insert into document_line_tax_components
            (org_id, document_line_id, tax_code_id, sequence, rate_percent,
             taxable_amount, tax_amount, recoverable_amount, nonrecoverable_amount,
             calculation_type, price_includes_tax, compound_on_previous, rounding_scale,
             collected_by, facilitator_name,
             collected_account_id, paid_account_id, withholding_account_id, overridden,
             created_by, updated_by)
          select org_id, ${newLineId}, tax_code_id, sequence, rate_percent,
                 taxable_amount, tax_amount, recoverable_amount, nonrecoverable_amount,
                 calculation_type, price_includes_tax, compound_on_previous, rounding_scale,
                 collected_by, facilitator_name,
                 collected_account_id, paid_account_id, withholding_account_id, overridden,
                 ${actorId}, ${actorId}
            from document_line_tax_components
           where org_id = ${orgId} and document_line_id = ${line.id}
        `);
      }

      for (const draft of bucket) {
        const superseded = await db.execute(sql`
          update documents
             set custom = coalesce(custom, '{}'::jsonb) || ${JSON.stringify({
               consolidationStatus: "superseded",
               supersededBy: invoiceId,
             })}::jsonb,
                 updated_at = now(), updated_by = ${actorId}
           where org_id = ${orgId} and id = ${draft.id} and status = 'draft'
          returning id
        `);
        if (superseded.rows.length !== 1) {
          throw new ConsolidatedBillingError(
            `invoice ${draft.documentNumber} left draft after collection — void or post it standalone before consolidating this period`,
          );
        }
        await db.execute(sql`
          insert into document_links (org_id, from_document_id, to_document_id, link_type, reason, created_by, updated_by)
          values (${orgId}, ${draft.id}, ${invoiceId}, 'created_from',
                  ${`Consolidated into ${documentNumber} (${group.code} ${periodStart} → ${periodEnd})`},
                  ${actorId}, ${actorId})
        `);
      }

      const run = (await db.execute<{ id: string }>(sql`
        insert into consolidation_runs
          (org_id, group_id, period_start, period_end, currency, billing_subsidiary_id, invoice_id, created_by, updated_by)
        values (${orgId}, ${groupId}, ${periodStart}::date, ${periodEnd}::date,
                ${currency}, ${billingSubsidiaryId}, ${invoiceId}, ${actorId}, ${actorId})
        returning id
      `));
      if (run.rows.length !== 1) {
        throw new ConsolidatedBillingError(
          `consolidation for ${periodStart} through ${periodEnd} changed before its guard could be recorded — reload and retry`,
        );
      }

      let posted = false;
      if (opts.autoPost) {
        const submission = await submitAndReleaseIfUngated("customer_invoice", invoiceId, actorId);
        if (submission.flowError) {
          throw new ConsolidatedBillingError(`approval could not be routed: ${submission.flowError}`);
        }
        if (!submission.gated) {
          await postDocument(invoiceId, { control: await loadRequiredControlAccounts(orgId) }, {
            audit: { actorId, source: "consolidation_run" },
          });
          posted = true;
        }
      }

      results.push({
        runId: run.rows[0]!.id,
        groupId,
        periodStart,
        periodEnd,
        currency,
        billingSubsidiaryId,
        invoiceId,
        documentNumber,
        posted,
        supersededDraftIds: draftIds,
        subtotal: sums.subtotal,
        taxTotal: sums.taxTotal,
        total: sums.total,
        replayed: false,
      });
    }
    return results;
  });
}

export interface ConsolidationScanResult {
  consolidated: number;
  replayed: number;
  failed: number;
  orgErrors: { orgId: string; error: string }[];
}

/**
 * One scan tick over every active consolidation group: each closed bucket
 * holding pending drafts consolidates into the payer invoice, still as a
 * draft for review — the scan never auto-posts. A bucket consolidates once;
 * later ticks replay it without writing. Organizations with the feature off
 * are skipped outright, and one group's failure is recorded against its org
 * without taking the other groups down.
 */
export async function runDueConsolidations(asOf?: string): Promise<ConsolidationScanResult> {
  const result: ConsolidationScanResult = { consolidated: 0, replayed: 0, failed: 0, orgErrors: [] };
  // Simulation (and other tenant-scoped callers) run this helper while an
  // ambient org context is active. Keep that context as a hard candidate
  // boundary even though the scheduler's unscoped invocation legitimately
  // scans every production tenant under bypass: without this predicate, one
  // tenant's scan would consolidate unrelated tenants' pending drafts.
  const scopedOrgId = orgContext.getStore()?.orgId;
  const orgScope = scopedOrgId ? sql`and g.org_id = ${scopedOrgId}` : sql``;
  // bypass: scheduler-tick — the unscoped scan finds active groups across
  // every production organization.
  const groups = await withBypass(async () =>
    (await db.execute<{ orgId: string; groupId: string; cadence: string; cutoffDay: number }>(sql`
      select g.org_id as "orgId", g.id as "groupId",
             g.cadence as "cadence", g.cutoff_day as "cutoffDay"
        from consolidation_groups g
       where g.is_active ${orgScope}
       order by g.org_id, g.id`)).rows);
  const gated = new Map<string, boolean>();
  const orgToday = new Map<string, string>();
  const dateFailed = new Set<string>();
  for (const group of groups) {
    let enabled = gated.get(group.orgId);
    if (enabled === undefined) {
      enabled = await withOrg(group.orgId, () => orgFeatureEnabled(group.orgId, "consolidatedBilling"));
      gated.set(group.orgId, enabled);
    }
    if (!enabled || dateFailed.has(group.orgId)) continue;
    let today = asOf ?? orgToday.get(group.orgId);
    if (!today) {
      try {
        today = await withOrg(group.orgId, () => businessToday(group.orgId));
        orgToday.set(group.orgId, today);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        result.failed += 1;
        result.orgErrors.push({ orgId: group.orgId, error: `business day unavailable: ${message}` });
        dateFailed.add(group.orgId);
        continue;
      }
    }
    try {
      // Tenant scope for the whole group pass: without it the pending-draft
      // read below matches zero rows under RLS and the scan silently
      // consolidates nothing. runConsolidationGroup re-enters the same
      // scope (same org reuses the transaction) for each bucket.
      await withOrg(group.orgId, () => consolidateDueBuckets(group.orgId, group, today, result));
    } catch (e) {
      result.failed += 1;
      const message = (e instanceof Error ? e.message : String(e)).slice(0, 1000);
      result.orgErrors.push({ orgId: group.orgId, error: message });
    }
  }
  return result;
}

type ScanGroup = { groupId: string; cadence: string; cutoffDay: number };

/**
 * Consolidate one group's closed buckets that still hold pending drafts.
 * Buckets derive from the drafts themselves, so an empty or fully
 * consolidated group costs one indexed read and no run. Backlog drains
 * twelve buckets per tick — a year of monthly periods — so one pathological
 * group cannot hold the scan open.
 */
async function consolidateDueBuckets(
  orgId: string,
  group: ScanGroup,
  today: string,
  result: ConsolidationScanResult,
): Promise<void> {
  const shape = { cadence: group.cadence as "weekly" | "monthly", cutoffDay: group.cutoffDay };
  const pendings = (await db.execute<{ documentDate: string }>(sql`
    select distinct d.document_date::text as "documentDate"
      from documents d
     where d.org_id = ${orgId} and d.kind = 'customer_invoice' and d.status = 'draft'
       and d.custom->>'consolidationStatus' = 'pending_consolidation'
       and d.custom->>'consolidationGroupId' = ${group.groupId}
     order by 1`)).rows;
  const buckets = new Map<string, { periodStart: string; periodEnd: string }>();
  for (const pending of pendings) {
    const bucket = consolidationPeriodFor(shape, pending.documentDate);
    if (bucket.periodEnd < today) buckets.set(`${bucket.periodStart}/${bucket.periodEnd}`, bucket);
  }
  const ordered = [...buckets.values()].sort((a, b) => (a.periodStart < b.periodStart ? -1 : 1)).slice(0, 12);
  for (const bucket of ordered) {
    const runs = await runConsolidationGroup(orgId, group.groupId, bucket.periodStart, bucket.periodEnd);
    for (const run of runs) {
      if (run.replayed) result.replayed += 1;
      else result.consolidated += 1;
    }
  }
}

/** Rent billing, straight-line levelling, late fees, scheduler run. Split from property/management.ts (ARCH-FILE-SPLIT; pure moves only). */
import { sql } from "drizzle-orm";
import { db, withBypass, withOrg, withOrgTransaction } from "../platform/db.ts";
import { businessToday } from "../platform/business-date.ts";
import { inventoryFeatureEnabled } from "../inventory/profile-policy.ts";
import { createSubscriptionInvoice } from "../billing/subscription-billing.ts";
import type { AdvancedBillingLine } from "../billing/advanced-subscriptions.ts";
import { apportion } from "../revenue/recognition.ts";
import { assertPeriodModulesOpen, CloseError } from "../periods/period-policy.ts";
import { resolveCoveringPeriod } from "../periods/period-resolution.ts";
import { loadSubsidiaryContext, SubsidiaryError, uuidArray, validateSubsidiaryRestrictions } from "../organization/subsidiaries.ts";
import { subsidiaryVisibleFilter } from "../organization/subsidiary-scope.ts";
import { postEntry } from "../journal/post-entry.ts";
import { cmp, fromUnits, mulPercent, mulRatio, neg, toUnits } from "../money/money.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { addDays, addMonths, assertEnabled, assertLockedSubsidiaryInScope, audit, dayCount, exactMoney, INVENTORY_ITEM_KINDS, lockLeasePropertyInScope, lockPropertyInScope, PropertyManagementError, startOfMonth, validDate, type DueLeaseChargeRow, type LateFeeRow } from "./management-foundation.ts";
import { leaseChargeSchedule } from "./management-foundation.ts";
import { scheduleLeaseCharges } from "./lease-schedules.ts";

function billingKey(leaseId: string, scheduleIds: string[]): string { return `rent:${leaseId}:${[...scheduleIds].sort().join(",")}`; }
/** Called only while the generating source reservation is locked. */
export async function propertyBillingGeneration(orgId: string, key: string, kind: "customer_invoice" | "customer_credit") {
  const prior = (await db.execute<{ id: string; status: string }>(sql`
    select id,status from documents where org_id=${orgId} and kind=${kind}
      and (custom->'propertyManagement'->>'billingKey'=${key}
        or custom->'propertyManagement'->>'originalBillingKey'=${key})
    order by created_at desc,id desc`));
  const predecessorId = prior.rows[0]?.id;
  return {
    documentId: prior.rows.find(row => row.status !== 'voided')?.id,
    predecessorId,
    generationKey: predecessorId ? `${key}:after:${predecessorId}` : key,
  };
}
export interface LeaseLevellingResult {
  leaseId: string;
  leaseNumber: string;
  /** Straight-line income attributable to completed billing periods. */
  straightLineToDate: string;
  /** Contractual rent billed for those same periods. */
  billedToDate: string;
  /** SL − billed: the rent receivable (positive) or deferred rent (negative). */
  targetAccrual: string;
  postedAccrual: string;
  delta: string;
  entryId: string | null;
}
/**
 * Straight-line an operating lease's escalating rent (IFRS 16.81 /
 * ASC 842-30-25-11): income is level over the term regardless of the billing
 * pattern, so a lease billed 10k→14k over five years recognises 12k a year,
 * accruing a rent receivable while billing lags and releasing it as billing
 * catches up — returning to exactly zero at the end of the term.
 *
 * The mechanism: rebuild the FULL contractual base-rent stream (all charge
 * rows including applied escalations, over the whole lease term), apportion
 * the total across the billing periods (day-weighted for partial first/last
 * periods, equal otherwise), and true the cumulative accrual up for every
 * COMPLETED period as of `asOf`. Idempotent: the posted accrual is measured
 * from the ledger, so a rerun with no change posts nothing.
 *
 * Requires a determinable term (`ends_on`) — an open-ended lease has no total
 * to level. Accounts: income from the property's rent income account; the
 * accrual sits on `orgs.settings.controlAccounts.straightLineRent`.
 */
export async function levelLeaseRentStraightLine(
  orgId: string,
  actorId: string | null,
  opts: { asOf: string; onlyLeaseId?: string; allowedSubsidiaryIds: ReadonlySet<string> | null },
): Promise<LeaseLevellingResult[]> {
  await assertEnabled(db, orgId);
  const asOf = validDate(opts.asOf, "Levelling date")!;
  // Levelling posts accrual journals per lease: without a lease pin the run
  // is portfolio-wide, which a subsidiary-restricted caller may never run.
  if (opts.allowedSubsidiaryIds !== null && !opts.onlyLeaseId) {
    throw new PropertyManagementError("Bulk portfolio billing requires unrestricted subsidiary access", 403);
  }

  const candidates = (await db.execute<{ id: string }>(sql`
    select l.id from property_leases l join managed_properties p on p.id=l.property_id and p.org_id=l.org_id
    where l.org_id=${orgId} and l.status in ('active','notice') and l.ends_on is not null
      and (${opts.onlyLeaseId ?? null}::uuid is null or l.id=${opts.onlyLeaseId ?? null})
      ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, opts.allowedSubsidiaryIds)}
    order by l.lease_number,l.id`)).rows;
  const results: LeaseLevellingResult[] = [];
  for (const candidate of candidates) {
    const result = await withOrgTransaction(orgId, async () => {
      if (!(await lockAndCheckOrgFeature(db, orgId, "propertyManagement"))) {
        throw new PropertyManagementError("Property management feature is disabled");
      }
      await db.execute(sql`select id from subsidiaries where org_id=${orgId} order by id for share`);
      const slAccount = (await db.execute<{ acct: string | null }>(sql`
        select settings->'controlAccounts'->>'straightLineRent' as acct from orgs where id = ${orgId} for share
      `));
      const straightLineRentAccountId = slAccount.rows[0]?.acct ?? null;
      const claimed = (await db.execute<{ id: string }>(sql`select id from property_leases
        where org_id=${orgId} and id=${candidate.id} for update`)).rows[0];
      if (!claimed) return null;
      const leaseRows = (await db.execute<{
          id: string; leaseNumber: string; startsOn: string; endsOn: string; billingDay: number;
          tenantId: string; subsidiaryId: string; locationId: string | null; currency: string;
          rentIncomeAccountId: string | null;
        }>(sql`
        select l.id, l.lease_number as "leaseNumber", l.starts_on as "startsOn", l.ends_on as "endsOn",
               l.billing_day as "billingDay", l.tenant_id as "tenantId",
               p.subsidiary_id as "subsidiaryId", p.location_id as "locationId", p.currency,
               p.rent_income_account_id as "rentIncomeAccountId"
          from property_leases l
          join managed_properties p on p.id = l.property_id and p.org_id = l.org_id
         where l.org_id = ${orgId} and l.status in ('active','notice') and l.ends_on is not null
           and l.id = ${candidate.id}
         for share of p`));
      const lease = leaseRows.rows[0];
      if (!lease) return null;
      // The lease row is claimed FOR UPDATE above and the property FOR
      // SHARE: a concurrent rehome waits on the share lock, so this
      // subsidiary is current and the uniform denial closes the race.
      assertLockedSubsidiaryInScope(opts.allowedSubsidiaryIds, lease.subsidiaryId);
      // All contract, property and account inputs are read after claiming the
      // lease. An edit that committed while we waited must shape this accrual.
      const charges = (await db.execute<{ amount: string; frequency: "monthly" | "quarterly" | "annually" | "one_time"; effectiveFrom: string; effectiveTo: string | null }>(sql`
        select amount, frequency, effective_from as "effectiveFrom", effective_to as "effectiveTo"
          from lease_charges
         where org_id = ${orgId} and lease_id = ${lease.id} and charge_type = 'base_rent'
         order by effective_from, id for share`));
      if (charges.rows.length === 0) return null;

      // The full contractual stream over the term, with a day-count weight per
      // billing period (1 for full periods, the active/nominal ratio otherwise).
      const rows: { periodEndsOn: string; amount: string; weight: string }[] = [];
      for (const charge of charges.rows) {
        if (charge.frequency === "one_time") continue; // not periodic rent
        const step = charge.frequency === "monthly" ? 1 : charge.frequency === "quarterly" ? 3 : 12;
        for (const period of leaseChargeSchedule({
          amount: charge.amount, frequency: charge.frequency,
          effectiveFrom: charge.effectiveFrom, effectiveTo: charge.effectiveTo,
          leaseStartsOn: lease.startsOn, leaseEndsOn: lease.endsOn,
          throughOn: lease.endsOn, billingDay: lease.billingDay,
        })) {
          const nominalStart = startOfMonth(period.periodStartsOn);
          const nominalEnd = addDays(addMonths(nominalStart, step), -1);
          const active = dayCount(period.periodStartsOn, period.periodEndsOn);
          const nominal = dayCount(nominalStart, nominalEnd);
          rows.push({
            periodEndsOn: period.periodEndsOn,
            amount: period.amount,
            weight: active >= nominal ? "1" : mulRatio("1", BigInt(active), BigInt(nominal)),
          });
        }
      }
      if (rows.length === 0) return null;
      rows.sort((a, b) => (a.periodEndsOn < b.periodEndsOn ? -1 : a.periodEndsOn > b.periodEndsOn ? 1 : 0));

      const totalUnits = rows.reduce((a, r) => a + toUnits(r.amount), 0n);
      const level = apportion(totalUnits, rows.map((r) => r.weight));
      let straightLine = 0n;
      let billed = 0n;
      for (let i = 0; i < rows.length; i++) {
        if (rows[i]!.periodEndsOn > asOf) break;
        straightLine += level[i]!;
        billed += toUnits(rows[i]!.amount);
      }
      const target = straightLine - billed;
      const posted = (await db.execute<{ accrual: string }>(sql`
        select coalesce(sum(jl.amount), 0)::text as accrual
          from journal_lines jl
          join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id and je.status in ('posted','reversed')
         where jl.org_id = ${orgId} and je.origin = 'lease'
           and je.custom->'propertyManagement'->>'levellingLeaseId' = ${lease.id}
           and (${straightLineRentAccountId}::uuid is null or jl.account_id = ${straightLineRentAccountId}::uuid)
      `));
      const postedAccrual = posted.rows[0]?.accrual ?? "0";
      const deltaUnits = target - toUnits(postedAccrual);
      const result: LeaseLevellingResult = {
        leaseId: lease.id, leaseNumber: lease.leaseNumber,
        straightLineToDate: fromUnits(straightLine), billedToDate: fromUnits(billed),
        targetAccrual: fromUnits(target), postedAccrual,
        delta: fromUnits(deltaUnits), entryId: null,
      };
      if (deltaUnits === 0n) return result;
      if (!straightLineRentAccountId) {
        throw new PropertyManagementError(
          "Configure the straight-line rent account (Company Settings → controlAccounts.straightLineRent) before levelling lease income",
        );
      }
      if (!lease.rentIncomeAccountId) {
        throw new PropertyManagementError(`Property for lease ${lease.leaseNumber} has no rent income account`);
      }

      // The levelling accrual is an ordinary posting: the period resolves
      // through the shared covering-period resolver (default calendar,
      // regular periods, deterministic).
      const levelPeriod = await resolveCoveringPeriod(db, orgId, asOf);
      if (!levelPeriod) throw new PropertyManagementError(`No accounting period covers ${asOf}`);
      const levelPeriodId: string = levelPeriod.id;
      const ctx = (await db.execute<{ book_id: string | null }>(sql`
        select (select id from accounting_books where org_id = ${orgId} and is_primary and is_active and posts_gl limit 1 for share) as book_id
      `));
      if (!ctx.rows[0]?.book_id) throw new PropertyManagementError("No active primary posting book");
      const levelBookId: string = ctx.rows[0].book_id;
      // Direct journal writes bypass the document posting path, so the GL
      // close fence that guards documents never sees this accrual: refuse a
      // closed target period here instead of tripping the storage guard.
      // One period gate: the shared GL check replaces the raw
      // period_module_is_closed query. Levelling is new local activity, not
      // historical replay, so source-owned imported locks refuse exactly
      // like user locks.
      try {
        await assertPeriodModulesOpen(db, {
          orgId,
          periodId: levelPeriodId,
          bookId: levelBookId,
          subsidiaryIds: [lease.subsidiaryId],
          modules: ["gl"],
        });
      } catch (error) {
        if (error instanceof CloseError) {
          throw new PropertyManagementError(`The GL period covering ${asOf} is closed; straight-line rent cannot post into it`);
        }
        throw error;
      }

      const subsidiaryContext = await loadSubsidiaryContext(db, orgId);
      const subsidiary = subsidiaryContext.byId.get(lease.subsidiaryId);
      if (!subsidiary?.isActive) throw new PropertyManagementError("Rent levelling subsidiary is missing or inactive");
      if (lease.currency !== subsidiary.baseCurrency) {
        throw new PropertyManagementError("Rent levelling requires the property currency to match the subsidiary functional currency");
      }
      const accountIds = [straightLineRentAccountId, lease.rentIncomeAccountId];
      await db.execute(sql`select id from accounts where org_id=${orgId}
        and id=any(${uuidArray(accountIds)}::uuid[]) order by id for share`);
      if (lease.locationId) await db.execute(sql`select id from locations
        where org_id=${orgId} and id=${lease.locationId} for share`);
      try {
        await validateSubsidiaryRestrictions(db, {
          orgId, ctx: subsidiaryContext, docSubsidiaryId: lease.subsidiaryId,
          lines: accountIds.map((accountId) => ({ accountId, amount: fromUnits(deltaUnits),
            subsidiaryId: lease.subsidiaryId, locationId: lease.locationId })),
        });
      } catch (error) {
        if (error instanceof SubsidiaryError) throw new PropertyManagementError(error.message);
        throw error;
      }

      const amount = fromUnits(deltaUnits < 0n ? -deltaUnits : deltaUnits);
      const memo = `Straight-line rent levelling — ${lease.leaseNumber} (as of ${asOf})`;
      // delta > 0: income levelled ABOVE billing → DR accrual / CR income.
      // delta < 0: billing ran ahead (or the accrual releases) → reverse.
      const accrualLeg = deltaUnits > 0n ? amount : neg(amount);
      const incomeLeg = neg(accrualLeg);
      // Every journal write routes through the ONE ledger API.
      const postedLevel = await postEntry(db, {
        orgId,
        bookId: levelBookId,
        subsidiaryId: lease.subsidiaryId,
        entryNumber: `SLR-${lease.leaseNumber}-${asOf}-${crypto.randomUUID().slice(0, 8)}`,
        postingDate: asOf,
        periodId: levelPeriodId,
        memo,
        origin: "lease",
        custom: { propertyManagement: { levellingLeaseId: lease.id, asOf } },
        actorId,
        currency: lease.currency,
        closeModules: ["gl"],
        lines: [
          {
            accountId: straightLineRentAccountId,
            amount: accrualLeg,
            locationId: lease.locationId,
            partyId: lease.tenantId,
            memo,
          },
          {
            accountId: lease.rentIncomeAccountId,
            amount: incomeLeg,
            locationId: lease.locationId,
            partyId: lease.tenantId,
            memo,
          },
        ],
      });
      const eid = postedLevel.entryId;
      result.entryId = eid;
      return result;
    });
    if (result) results.push(result);
  }
  return results;
}
/**
 * Bill every lease whose schedule lines are due as of `asOf`.
 *
 * `actorId` is the authenticated caller on interactive paths; a null actor is
 * the engine-wide system identity for scheduler runs. There is deliberately NO
 * fallback to `lease.created_by`: a null-author lease bills under system
 * provenance instead of throwing or impersonating its historical author, and a
 * real user's id never leaks onto another actor's artifacts.
 */
export async function billDueLeaseCharges(orgId: string, actorId: string | null, allowedSubsidiaryIds: ReadonlySet<string> | null, asOf?: string, onlyLeaseId?: string, onlyPropertyId?: string): Promise<{ billed: number; invoices: string[] }> {
  const through = validDate(asOf, "Billing date") ?? await businessToday(orgId);
  await assertEnabled(db, orgId);
  // Portfolio-wide billing without a lease or property pin touches every
  // entity at once: a subsidiary-restricted caller may never run it, whether
  // from the route or by calling the service directly.
  if (allowedSubsidiaryIds !== null && !onlyLeaseId && !onlyPropertyId) {
    throw new PropertyManagementError("Bulk portfolio billing requires unrestricted subsidiary access", 403);
  }
  // Discovery only chooses candidates. It is not the financial snapshot used
  // for invoicing: lease controls and schedule proration may change while we wait.
  // Termination stops future rent, but its already-prorated earned schedules
  // remain collectible. Never admit a legacy period crossing the termination date.
  const due = (await db.execute<{ id: string; leaseId: string }>(sql`
    select s.id,s.lease_id as "leaseId"
    from lease_schedule_lines s
    join property_leases l on l.id=s.lease_id and l.org_id=s.org_id
    join managed_properties p on p.id=l.property_id and p.org_id=l.org_id
    where s.org_id=${orgId} and s.status='scheduled' and s.due_on<=${through}
      and (l.status in ('active','notice') or (l.status='terminated' and s.period_ends_on<=least(l.ends_on,l.move_out_on)))
      and l.auto_invoice and (${onlyLeaseId ?? null}::uuid is null or l.id=${onlyLeaseId ?? null})
      and (${onlyPropertyId ?? null}::uuid is null or l.property_id=${onlyPropertyId ?? null})
      ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds)} order by l.id,s.due_on,s.id
  `));
  const groups = new Map<string, string[]>();
  for (const row of due.rows) groups.set(row.leaseId, [...(groups.get(row.leaseId) ?? []), row.id]);
  const invoices: string[] = [];
  for (const [leaseId, candidateIds] of groups) {
    await withOrgTransaction(orgId, async () => {
      // Escalations lock a charge before its schedules, so this loop takes
      // the charge share lock FIRST — parked on a competing charge lock it
      // holds nothing, and a concurrent escalation apply holding the charge
      // can always run to commit. Lease before schedule still matches the
      // termination/lease-edit lock order: a non-key lock still permits
      // foreign-key checks when an escalation inserts its replacement charge
      // before releasing the old charge lock.
      await db.execute(sql`select id from lease_charges where org_id=${orgId} and lease_id=${leaseId} order by id for share`);
      const lease = (await db.execute<{ property_id: string }>(sql`
        select property_id from property_leases where org_id=${orgId} and id=${leaseId}
          and status in ('active','notice','terminated') and auto_invoice
          and (${onlyPropertyId ?? null}::uuid is null or property_id=${onlyPropertyId ?? null})
        for no key update`)).rows[0];
      if (!lease) return;
      // The property lock below serializes a concurrent rehome; the
      // subsidiary is rechecked inside this same transaction, so a lease
      // discovered in-scope cannot bill after its property moved away.
      await lockPropertyInScope(db, orgId, String(lease.property_id), allowedSubsidiaryIds);
      await db.execute(sql`select id from managed_properties where org_id=${orgId} and id=${lease.property_id} for share`);
      // Charge policy was frozen above; read the full invoice inputs under
      // row locks.
      await assertEnabled(db, orgId);
      const locked = (await db.execute<DueLeaseChargeRow>(sql`
        select s.id,s.lease_id as "leaseId",s.due_on as "dueOn",s.amount,s.period_starts_on as "periodStartsOn",s.period_ends_on as "periodEndsOn",
          c.description,c.income_account_id as "incomeAccountId",c.item_id as "itemId",c.tax_code_id as "taxCodeId",
          l.tenant_id as "tenantId",l.lease_number as "leaseNumber",l.payment_terms_days as "paymentTermsDays",l.auto_post as "autoPost",
          p.subsidiary_id as "subsidiaryId",p.location_id as "locationId",p.currency
        from lease_schedule_lines s
        join lease_charges c on c.id=s.charge_id and c.org_id=s.org_id
        join property_leases l on l.id=s.lease_id and l.org_id=s.org_id
        join managed_properties p on p.id=l.property_id and p.org_id=l.org_id
        where s.org_id=${orgId} and s.lease_id=${leaseId} and s.status='scheduled' and s.due_on<=${through}
          and (l.status in ('active','notice') or (l.status='terminated' and s.period_ends_on<=least(l.ends_on,l.move_out_on)))
          and s.id::text in (select jsonb_array_elements_text(${JSON.stringify(candidateIds)}::jsonb))
        order by s.id for update of s
      `));
      const billRows = locked.rows;
      if (!billRows.length) return;
      const ids = billRows.map((row) => row.id);
      const key = billingKey(leaseId, ids);
      const first = billRows[0]!;
      const generation = await propertyBillingGeneration(orgId, key, "customer_invoice");
      let invoiceId = generation.documentId;
      // Posted predecessors retain their keys; replacements link each generation.
      const { predecessorId, generationKey } = generation;
      if (!invoiceId) {
        // Stored schedule lines and an existing invoice stay. Copying an
        // inventory / assembly / kit item onto a new invoice is Inventory configuration.
        if (!(await inventoryFeatureEnabled(db, orgId))) {
          for (const row of billRows) {
            if (!row.itemId) continue;
            const item = (await db.execute<{ kind: string }>(sql`
              select kind from items where id = ${row.itemId} and org_id = ${orgId}`));
            if (item.rows[0] && INVENTORY_ITEM_KINDS.has(item.rows[0].kind)) {
              throw new PropertyManagementError("Inventory is disabled", 404);
            }
          }
        }
        const lines: AdvancedBillingLine[] = billRows.map((row) => ({ description: `${row.description} · ${row.periodStartsOn}–${row.periodEndsOn}`, quantity: "1", unitPrice: row.amount, incomeAccountId: row.incomeAccountId, itemId: row.itemId, taxCodeId: row.taxCodeId }));
        const generated = await createSubscriptionInvoice({ orgId, actorId, customerId: first.tenantId, subsidiaryId: first.subsidiaryId,
          locationId: first.locationId, currency: first.currency, incomeAccountId: null, itemId: null, taxCodeId: null,
          description: `Lease ${first.leaseNumber}`, quantity: "1", unitPrice: "0", memo: `Lease ${first.leaseNumber}`,
          invoiceDate: through, dueDate: addDays(through, first.paymentTermsDays), autoPost: first.autoPost, lines,
          postingAuditSource: "property_rent_billing",
          custom: { propertyManagement: {
            billingKey: generationKey, originalBillingKey: key,
            ...(predecessorId ? { predecessorInvoiceId: predecessorId } : {}),
            leaseId, scheduleIds: ids, kind: "rent",
            billingRunSource: actorId === null ? "scheduler" : "user",
            ...(actorId === null ? { actorKind: "system", actorReason: "scheduled lease rent billing" } : {}),
          } } });
        invoiceId = generated.invoiceId;
      }
      await db.execute(sql`update lease_schedule_lines set status='invoiced',invoice_document_id=${invoiceId},updated_at=now(),updated_by=${actorId}
        where org_id=${orgId} and status='scheduled' and id::text in (select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))`);
      invoices.push(invoiceId);
    });
  }
  const billed = invoices.length
    ? (await db.execute<{ n: number }>(sql`select count(*)::int as n from lease_schedule_lines where org_id=${orgId} and invoice_document_id::text in (select jsonb_array_elements_text(${JSON.stringify(invoices)}::jsonb))`))
    : { rows: [{ n: 0 }] };
  return { billed: billed.rows[0]?.n ?? 0, invoices };
}
/**
 * Assess late fees for every overdue posted lease invoice as of `asOf`.
 *
 * `actorId` is the authenticated caller on interactive paths; a null actor is
 * the engine-wide system identity for scheduler runs. Each generated fee is
 * attributed at its own source line (never an org-wide stand-in) and commits
 * with its audit evidence inside one transaction.
 */
export async function assessLeaseLateFees(orgId: string, actorId: string | null, allowedSubsidiaryIds: ReadonlySet<string> | null, asOf?: string, onlyLeaseId?: string, onlyPropertyId?: string): Promise<{ created: number }> {
  const date = validDate(asOf ?? await businessToday(orgId), "Late-fee date")!;
  await assertEnabled(db, orgId);
  if (allowedSubsidiaryIds !== null && !onlyLeaseId && !onlyPropertyId) {
    throw new PropertyManagementError("Bulk portfolio billing requires unrestricted subsidiary access", 403);
  }
  const overdue = (await db.execute<LateFeeRow>(sql`
    select (array_agg(s.id order by s.id))[1] as source_schedule_id,s.lease_id,
      l.late_fee_type,l.late_fee_value,p.rent_income_account_id,oi.transaction_open
    from lease_schedule_lines s join property_leases l on l.id=s.lease_id and l.org_id=s.org_id
    join managed_properties p on p.id=l.property_id and p.org_id=l.org_id join documents d on d.id=s.invoice_document_id and d.org_id=s.org_id
    join lateral (
      select greatest(abs(jl.txn_amount)-coalesce(sum(a.target_transaction_amount) filter(where a.unapplied_at is null),0),0)::text as transaction_open
      from journal_lines jl left join applications a on a.to_line_id=jl.id and a.org_id=jl.org_id
      where jl.entry_id=d.posted_entry_id and jl.org_id=d.org_id and jl.is_open_item and jl.amount>0
      group by jl.id
    ) oi on true
    where s.org_id=${orgId} and s.status='invoiced' and l.status in ('active','notice') and l.late_fee_type<>'none'
      and (${onlyLeaseId ?? null}::uuid is null or l.id=${onlyLeaseId ?? null})
      and (${onlyPropertyId ?? null}::uuid is null or l.property_id=${onlyPropertyId ?? null})
      ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds)}
      and d.kind='customer_invoice' and d.status='posted' and d.due_date is not null and d.due_date + l.grace_days < ${date}
      and oi.transaction_open::numeric>0
    group by d.id,s.lease_id,l.late_fee_type,l.late_fee_value,p.rent_income_account_id,oi.transaction_open
  `));
  let created = 0;
  for (const row of overdue.rows) {
    const amount = row.late_fee_type === "fixed" ? exactMoney(row.late_fee_value, "Late-fee value") : mulPercent(row.transaction_open, row.late_fee_value);
    if (cmp(amount, "0") <= 0) continue;
    // The fee pair and its audit evidence commit as one unit: a failed audit
    // insert rolls the fee back so the next run re-assesses cleanly.
    await withOrgTransaction(orgId, async () => {
      await lockLeasePropertyInScope(db, orgId, String(row.lease_id), allowedSubsidiaryIds);
      const result = (await db.execute<{ id: string }>(sql`
        with charge as (insert into lease_charges(org_id,lease_id,charge_type,description,amount,frequency,effective_from,effective_to,income_account_id,created_by,updated_by)
          select ${orgId},${row.lease_id},'late_fee','Late fee',${amount},'one_time',${date},${date},${row.rent_income_account_id},${actorId},${actorId}
          where not exists(select 1 from lease_schedule_lines where org_id=${orgId} and source_schedule_id=${row.source_schedule_id}) returning id)
        insert into lease_schedule_lines(org_id,lease_id,charge_id,period_starts_on,period_ends_on,due_on,amount,source_schedule_id,created_by,updated_by)
        select ${orgId},${row.lease_id},id,${date},${date},${date},${amount},${row.source_schedule_id},${actorId},${actorId} from charge returning id
      `));
      if (!result.rows.length) return;
      const feeLineId = result.rows[0]!.id;
      await audit(db, orgId, "lease_schedule_lines", feeLineId, "late_fee_assess", actorId,
        { leaseId: row.lease_id, amount, lateFeeType: row.late_fee_type, sourceScheduleId: row.source_schedule_id,
          ...(actorId === null
            ? { source: "scheduler", actorKind: "system", actorReason: "scheduled lease late fees" }
            : { source: "user" }) },
        actorId === null ? `property-billing:late_fee:${row.lease_id}:${row.source_schedule_id}` : null);
      created += result.rows.length;
    });
  }
  return { created };
}
/**
 * Scheduler entry point. Each org/lease is idempotent through invoice billing
 * keys, schedule status, and the levelling true-up (a rerun with no change
 * posts nothing).
 *
 * The run is engine-initiated: every write it makes — schedule lines, rent
 * invoices, auto-posting, late fees, straight-line rent accruals — carries
 * system provenance (null actor) plus durable per-run/per-lease markers,
 * never a historical lease author and never an org-wide first actor.
 * Interactive callers attribute their own authenticated user instead.
 */
export async function runDuePropertyBilling(asOf?: string): Promise<{ billed: number; invoices: number; lateFees: number; levelled: number; orgErrors: { orgId: string; error: string }[] }> {
  const result: { billed: number; invoices: number; lateFees: number; levelled: number; orgErrors: { orgId: string; error: string }[] } =
    { billed: 0, invoices: 0, lateFees: 0, levelled: 0, orgErrors: [] };
  // Registry fallback shape: a non-boolean stored value falls back to the
  // default instead of throwing 22P02 like the previous ::boolean cast.
  const orgs = await withBypass(async () => (await db.execute<{ id: string }>(sql`select id from orgs where case (settings->'features'->>'propertyManagement') when 'true' then true when 'false' then false else false end`)));
  for (const org of orgs.rows) {
    try {
      await withOrg(org.id, async () => {
        // Each org bills on its own calendar day.
        const date = asOf ?? await businessToday(org.id);
        const leases = (await db.execute<{ id: string }>(sql`select id from property_leases where org_id=${org.id} and status in ('active','notice') and auto_invoice`));
        for (const lease of leases.rows) {
          // Null-author leases are ordinary scheduler work; no actor is consulted.
          // The scope sentinel is an explicit null: the engine-initiated tick
          // is organization-wide by design, never by omission.
          await scheduleLeaseCharges(org.id, null, null, lease.id);
        }
        const fees = await assessLeaseLateFees(org.id, null, null, date);
        const billed = await billDueLeaseCharges(org.id, null, null, date);
        result.billed += billed.billed; result.invoices += billed.invoices.length; result.lateFees += fees.created;
        // Level escalating operating leases after billing, like every other
        // scheduler step: the true-up is idempotent per lease per period, and a
        // misconfigured lease (no straight-line account, currency mismatch,
        // closed period) fails this org's run visibly (recorded in orgErrors)
        // instead of silently skipping the accrual. Flat and open-ended leases
        // return a zero delta and post nothing.
        const levelling = await levelLeaseRentStraightLine(org.id, null, { asOf: date, allowedSubsidiaryIds: null });
        result.levelled += levelling.filter((row) => row.entryId !== null).length;
      });
    } catch (e) {
      // Per-org isolation, same shape as dunning and subscription billing:
      // one tenant's misconfiguration is recorded by name and the loop
      // continues instead of silencing every later org's billing this tick.
      const message = e instanceof Error ? e.message : String(e);
      result.orgErrors.push({ orgId: org.id, error: message });
      console.error(`[property-billing] org ${org.id} billing failed:`, e);
    }
  }
  return result;
}

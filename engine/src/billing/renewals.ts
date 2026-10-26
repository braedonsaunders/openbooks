import { sql } from "drizzle-orm";
import { db, withOrg, withBypassContext } from "../platform/db.ts";
import { businessToday, civilDayIndex, isIsoCalendarDate } from "../platform/business-date.ts";
import { lockLedgerSetupFence } from "../organization/ledger-setup-fence.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import { documentKindPermissions } from "../records/document-kind-permissions.ts";
import { createCommercialDocument } from "../ledger/commercial-document.ts";
import { add, cmp, mul, mulPercent, prorateDays } from "../money/money.ts";
import {
  AdvancedSubscriptionError,
  advanceLifecycleDate,
  type Interval,
} from "./advanced-subscriptions.ts";
import { runRecordFlows } from "../flows/index.ts";

export function renewalUnitPrice(unitPrice: string, upliftPercent: string): string {
  if (cmp(unitPrice, "0") < 0 || cmp(upliftPercent, "0") < 0)
    throw new AdvancedSubscriptionError("Renewal prices and uplift must be non-negative");
  return add(unitPrice, mulPercent(unitPrice, upliftPercent));
}
export function renewalDue(termEndsOn: string, asOf: string, days: number): boolean {
  if (
    !isIsoCalendarDate(termEndsOn) ||
    !isIsoCalendarDate(asOf) ||
    !Number.isSafeInteger(days) ||
    days < 0 ||
    days > 3660
  )
    throw new AdvancedSubscriptionError("Renewal dates and lead days must be valid");
  const remaining = civilDayIndex(termEndsOn) - civilDayIndex(asOf);
  return remaining >= 0 && remaining <= days;
}
/** Total consideration follows the subscription cadence; a last partial
 * period is priced by exact service days, retaining the original month anchor. */
export function renewalTermAmount(
  unitPrice: string,
  start: string,
  end: string,
  interval: Interval,
  count: number,
  anchorDay = Number(start.slice(8)),
) {
  if (!isIsoCalendarDate(start) || !isIsoCalendarDate(end) || end <= start)
    throw new AdvancedSubscriptionError("Renewal service dates must be consecutive and increasing");
  let cursor = start,
    total = "0",
    periods = 0;
  while (cursor < end) {
    if (++periods > 10000)
      throw new AdvancedSubscriptionError("Renewal term exceeds the supported cadence window");
    const next = advanceLifecycleDate(cursor, interval, count, anchorDay),
      stop = next > end ? end : next;
    total = add(
      total,
      prorateDays(
        unitPrice,
        civilDayIndex(stop) - civilDayIndex(cursor),
        civilDayIndex(next) - civilDayIndex(cursor),
      ),
    );
    cursor = next;
  }
  return total;
}
type RenewalSubject = {
  id: string;
  customer_id: string;
  subsidiary_id: string;
  term_ends_on: string | null;
  status: string;
  renewal_policy: string;
  plan_version_id: string;
  plan_id: string;
  billing_timing: "advance" | "arrears";
  currency: string;
  interval: Interval;
  interval_count: number;
  term_starts_on: string;
};
type Policy = {
  id: string;
  owner_id: string;
  reminder_days: { days: number }[];
  generation_lead_days: number;
  document_kind: "quote" | "sales_order";
  uplift_percent: string;
  term_months: number;
  reason: string;
};

/** One native document per subscription expiry, serialized with subscription
 * billing/amendments. Drafts retain native commercial approval and tax.
 * Orders represent the service-term commitment; subscription invoices own
 * periodic delivery and relieve that commitment without duplicate fulfillment. */
export async function generateRenewalDocument(
  orgId: string,
  actorId: string,
  subscriptionId: string,
  asOf: string,
) {
  if (!isIsoCalendarDate(asOf)) throw new AdvancedSubscriptionError("Enter a renewal as-of date");
  const result = await withOrg(orgId, async () => {
    await lockLedgerSetupFence(db, orgId, "shared");
    await db.execute(
      sql`select id from subscriptions where org_id=${orgId} and id=${subscriptionId} for update`,
    );
    const subject = (
      await db.execute<RenewalSubject>(
        sql`
      select s.id,s.customer_id,s.status,coalesce(p.subsidiary_id,root.id) as subsidiary_id,l.term_ends_on::text,
        l.renewal_policy,l.plan_version_id,s.plan_id,l.billing_timing,v.interval,v.interval_count,l.term_starts_on::text,coalesce(v.currency_code,plan.currency_code) as currency
      from subscriptions s join parties p on p.org_id=s.org_id and p.id=s.customer_id
      join subscription_lifecycles l on l.org_id=s.org_id and l.subscription_id=s.id
      join subscription_plan_versions v on v.org_id=l.org_id and v.id=l.plan_version_id
      join subscription_plans plan on plan.org_id=s.org_id and plan.id=s.plan_id
      left join subsidiaries root on root.org_id=s.org_id and root.parent_id is null
      where s.org_id=${orgId} and s.id=${subscriptionId} for share of p,l,v,plan
    `,
        "objects",
      )
    )[0];
    if (!subject?.subsidiary_id) throw new ScopeNotFoundError();
    await lockActorCommandAuthority(db, orgId, actorId, subject.subsidiary_id, "ar.create");
    if (!(await lockAndCheckOrgFeature(db, orgId, "advancedSubscriptions")))
      throw new AdvancedSubscriptionError(
        "Enable Advanced subscriptions in Company Settings → Features",
      );
    if (subject.status !== "active" || !subject.term_ends_on || subject.renewal_policy === "none")
      throw new AdvancedSubscriptionError(
        "An active renewable subscription with a term end is required",
      );
    const policy = (
      await db.execute<Policy>(
        sql`
      select * from subscription_renewal_policies where org_id=${orgId} and subscription_id=${subscriptionId}
        and effective_from<=${asOf} and effective_to>=${asOf} for share
    `,
        "objects",
      )
    )[0];
    if (!policy)
      throw new AdvancedSubscriptionError(
        "Configure a dated renewal policy in Setup before generating the renewal",
      );
    await lockActorCommandAuthority(
      db,
      orgId,
      actorId,
      subject.subsidiary_id,
      documentKindPermissions(policy.document_kind)!.edit,
    );
    const existing = (
      await db.execute<{ document_id: string }>(
        sql`
      select document_id from subscription_renewal_occurrences where org_id=${orgId} and subscription_id=${subscriptionId}
        and term_ends_on=${subject.term_ends_on} and occurrence='document'
    `,
        "objects",
      )
    )[0];
    if (existing)
      return { documentId: existing.document_id, kind: policy.document_kind, created: null };
    if (!renewalDue(subject.term_ends_on, asOf, policy.generation_lead_days))
      throw new AdvancedSubscriptionError("Renewal is outside the configured generation window");
    const components = await db.execute<{
      component_key: string;
      name: string;
      quantity: string;
      unit_price: string;
      item_id: string | null;
      income_account_id: string | null;
      tax_code_id: string | null;
    }>(
      sql`
      select component_key,name,quantity::text,unit_price::text,item_id,income_account_id,tax_code_id from subscription_components
      where org_id=${orgId} and subscription_id=${subscriptionId} and effective_from<=${subject.term_ends_on}
        and (effective_to is null or effective_to>=${subject.term_ends_on}) order by sort_order,component_key for share
    `,
      "objects",
    );
    if (!components.length)
      throw new AdvancedSubscriptionError(
        "No subscription components are in force at renewal; configure the renewable offering",
      );
    const endsOn = advanceLifecycleDate(subject.term_ends_on, "monthly", policy.term_months);
    const lines = components.map((c) => {
      if (!c.income_account_id)
        throw new AdvancedSubscriptionError("Each renewed component requires its income account");
      const unitPrice = renewalTermAmount(
        renewalUnitPrice(c.unit_price, policy.uplift_percent),
        subject.term_ends_on!,
        endsOn,
        subject.interval,
        subject.interval_count,
        Number(subject.term_starts_on.slice(8)),
      );
      return {
        accountId: c.income_account_id,
        itemId: policy.document_kind === "sales_order" ? null : c.item_id,
        description: c.name,
        quantity: c.quantity,
        unitPrice,
        amount: mul(unitPrice, c.quantity),
        taxCodeId: c.tax_code_id,
        custom: {
          subscriptionComponent: {
            key: c.component_key,
            itemId: c.item_id,
            quantity: c.quantity,
            periodUnitPrice: renewalUnitPrice(c.unit_price, policy.uplift_percent),
          },
          renewalTermStartsOn: subject.term_ends_on,
          renewalTermEndsOn: endsOn,
        },
      };
    });
    const request = {
      partyId: subject.customer_id,
      documentDate: asOf,
      currency: subject.currency,
      memo: `Renewal ${subject.term_ends_on} through ${endsOn}`,
      referenceNumber: `Renewal ${subscriptionId}`,
      custom: {
        subscriptionRenewal: {
          subscriptionId,
          policyId: policy.id,
          termStartsOn: subject.term_ends_on,
          termEndsOn: endsOn,
          upliftPercent: policy.uplift_percent,
        },
      },
      lines,
    };
    const created = await createCommercialDocument({
      orgId,
      actorId,
      kind: policy.document_kind,
      body: request,
      subsidiaryId: subject.subsidiary_id,
    });
    const recorded = (
      await db.execute(
        sql`
      insert into subscription_renewal_occurrences(org_id,policy_id,subscription_id,term_ends_on,occurrence,document_id,snapshot,actor_id)
      values(${orgId},${policy.id},${subscriptionId},${subject.term_ends_on},'document',${created.id},${JSON.stringify({ subject, policy, request, components })}::jsonb,${actorId}) returning id
    `,
        "objects",
      )
    )[0];
    if (!recorded)
      throw new AdvancedSubscriptionError("Renewal document provenance could not be saved");
    return { documentId: created.id, kind: policy.document_kind, created };
  });
  if (result.created?.status === "created") {
    await runRecordFlows(
      { kind: "on_create", source: "schedule" },
      result.kind,
      result.documentId,
      { orgId, userId: actorId },
    );
    if (result.created.deferredUpdate)
      await runRecordFlows(result.created.deferredUpdate, result.kind, result.documentId, {
        orgId,
        userId: actorId,
      });
  }
  return { documentId: result.documentId, kind: result.kind };
}

/** Scheduler uses each policy's current operator authority; disabling the
 * feature or revoking that operator stops generation without deleting history. */
export async function runRenewalScan() {
  // bypass: scheduler-tick — discover renewal policies across organizations;
  // each target is re-entered with its tenant, feature and operator authority.
  const targets = await withBypassContext(() =>
    db.execute<{ org_id: string; subscription_id: string; owner_id: string }>(
      sql`
    select distinct p.org_id,p.subscription_id,p.owner_id from subscription_renewal_policies p
    join subscriptions s on s.org_id=p.org_id and s.id=p.subscription_id and s.status='active'
  `,
      "objects",
    ),
  );
  const problems: { orgId: string; error: string }[] = [];
  for (const target of targets) {
    try {
      const due = await withOrg(target.org_id, async () => {
        if (!(await lockAndCheckOrgFeature(db, target.org_id, "advancedSubscriptions"))) return;
        const today = await businessToday(target.org_id);
        const policy = (
          await db.execute<Policy & { subsidiary_id: string; term_ends_on: string }>(
            sql`
          select p.*,l.term_ends_on::text from subscription_renewal_policies p
          join subscription_lifecycles l on l.org_id=p.org_id and l.subscription_id=p.subscription_id
          where p.org_id=${target.org_id} and p.subscription_id=${target.subscription_id} and p.effective_from<=${today} and p.effective_to>=${today}
            and l.renewal_policy<>'none' and l.term_ends_on>=${today} for share of p,l
        `,
            "objects",
          )
        )[0];
        if (!policy) return;
        await lockActorCommandAuthority(
          db,
          target.org_id,
          policy.owner_id,
          policy.subsidiary_id,
          "ar.read",
        );
        await db.execute(
          sql`select pg_advisory_xact_lock(hashtext(${target.org_id}),hashtext(${`renewal-notice:${target.subscription_id}`}))`,
        );
        for (const offset of new Set(policy.reminder_days.map((offset) => offset.days))) {
          if (!renewalDue(policy.term_ends_on, today, offset)) continue;
          const occurrence = `reminder:${offset}`;
          if (
            (
              await db.execute(
                sql`select id from subscription_renewal_occurrences where org_id=${target.org_id} and subscription_id=${target.subscription_id} and term_ends_on=${policy.term_ends_on} and occurrence=${occurrence}`,
                "objects",
              )
            )[0]
          )
            continue;
          const notice = (
            await db.execute<{ id: string }>(
              sql`
            insert into notifications(org_id,user_id,kind,title,body,href,created_by,updated_by)
            values(${target.org_id},${policy.owner_id},'subscription_renewal','Subscription renewal approaching',${`Contract ends ${policy.term_ends_on}; review the renewal terms.`},${`/collections?subscription=${target.subscription_id}`},${policy.owner_id},${policy.owner_id}) returning id
          `,
              "objects",
            )
          )[0];
          if (!notice) throw new AdvancedSubscriptionError("Renewal reminder could not be saved");
          if (
            !(
              await db.execute(
                sql`
            insert into subscription_renewal_occurrences(org_id,policy_id,subscription_id,term_ends_on,occurrence,notification_id,snapshot,actor_id)
            values(${target.org_id},${policy.id},${target.subscription_id},${policy.term_ends_on},${occurrence},${notice.id},${JSON.stringify({ policy, offset })}::jsonb,${policy.owner_id}) returning id
          `,
                "objects",
              )
            )[0]
          )
            throw new AdvancedSubscriptionError("Renewal reminder evidence could not be saved");
        }
        return renewalDue(policy.term_ends_on, today, policy.generation_lead_days)
          ? { today, ownerId: policy.owner_id }
          : null;
      });
      if (due)
        await generateRenewalDocument(
          target.org_id,
          due.ownerId,
          target.subscription_id,
          due.today,
        );
    } catch (error) {
      problems.push({
        orgId: target.org_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return problems;
}

/** Approving the commercial renewal extends the existing subscription and
 * effective-dates the agreed component prices through the native amendment
 * ledger. Billing cursors and posted invoices remain intact. */
export async function acceptRenewalDocument(
  orgId: string,
  actorId: string,
  documentId: string,
  reason: string,
) {
  if (reason.trim().length < 8)
    throw new AdvancedSubscriptionError("Enter the commercial renewal acceptance reason");
  return withOrg(orgId, async () => {
    await lockLedgerSetupFence(db, orgId, "shared");
    const occurrence = (
      await db.execute<{
        subscription_id: string;
        term_ends_on: string;
        policy_id: string;
        snapshot: {
          subject: RenewalSubject;
          policy: Policy;
          components: {
            component_key: string;
            quantity: string;
            unit_price: string;
            income_account_id: string | null;
            item_id: string | null;
            tax_code_id: string | null;
          }[];
          request: {
            lines: {
              quantity: string;
              unitPrice: string;
              accountId: string;
              itemId: string | null;
            }[];
          };
        };
      }>(
        sql`
      select subscription_id,term_ends_on::text,policy_id,snapshot from subscription_renewal_occurrences where org_id=${orgId} and document_id=${documentId} and occurrence='document'
    `,
        "objects",
      )
    )[0];
    if (!occurrence) throw new ScopeNotFoundError();
    await db.execute(
      sql`select id from subscriptions where org_id=${orgId} and id=${occurrence.subscription_id} for update`,
    );
    await lockActorCommandAuthority(
      db,
      orgId,
      actorId,
      occurrence.snapshot.subject.subsidiary_id,
      "ar.post",
    );
    if (!(await lockAndCheckOrgFeature(db, orgId, "advancedSubscriptions")))
      throw new AdvancedSubscriptionError(
        "Enable Advanced subscriptions in Company Settings → Features",
      );
    if (
      (
        await db.execute(
          sql`select id from subscription_renewal_occurrences where org_id=${orgId} and subscription_id=${occurrence.subscription_id} and term_ends_on=${occurrence.term_ends_on} and occurrence='acceptance'`,
          "objects",
        )
      )[0]
    )
      return { subscriptionId: occurrence.subscription_id };
    const doc = (
      await db.execute<{
        status: string;
        party_id: string;
        subsidiary_id: string;
        currency: string;
        kind: string;
      }>(
        sql`select status,party_id,subsidiary_id,currency,kind from documents where org_id=${orgId} and id=${documentId} for update`,
        "objects",
      )
    )[0];
    if (
      !doc ||
      doc.kind !== occurrence.snapshot.policy.document_kind ||
      doc.status !== "approved" ||
      doc.party_id !== occurrence.snapshot.subject.customer_id ||
      doc.subsidiary_id !== occurrence.snapshot.subject.subsidiary_id ||
      doc.currency !== occurrence.snapshot.subject.currency
    )
      throw new AdvancedSubscriptionError(
        "Approve the original renewal quote or order with its subscription customer, legal entity and currency before acceptance",
      );
    await lockActorCommandAuthority(
      db,
      orgId,
      actorId,
      doc.subsidiary_id,
      documentKindPermissions(doc.kind)!.approve,
    );
    const term = (
      await db.execute<{ term_ends_on: string }>(
        sql`select term_ends_on::text from subscription_lifecycles where org_id=${orgId} and subscription_id=${occurrence.subscription_id} for update`,
        "objects",
      )
    )[0];
    if (term?.term_ends_on !== occurrence.term_ends_on)
      throw new AdvancedSubscriptionError(
        "The subscription term changed; review the current term before accepting a renewal",
      );
    const lines = await db.execute<{
      quantity: string;
      unit_price: string;
      account_id: string;
      item_id: string | null;
    }>(
      sql`select quantity::text,unit_price::text,account_id,item_id from document_lines where org_id=${orgId} and document_id=${documentId} order by line_number for share`,
      "objects",
    );
    if (
      lines.length !== occurrence.snapshot.request.lines.length ||
      lines.some((l, i) => {
        const expected = occurrence.snapshot.request.lines[i]!;
        return (
          cmp(l.quantity, expected.quantity) !== 0 ||
          cmp(l.unit_price, expected.unitPrice) !== 0 ||
          l.account_id !== expected.accountId ||
          l.item_id !== expected.itemId
        );
      })
    )
      throw new AdvancedSubscriptionError(
        "Restore the renewal document component quantities and quoted prices to its dated policy terms before acceptance",
      );
    const { applyAmendment } = await import("./advanced-subscriptions.ts");
    await applyAmendment(orgId, actorId, {
      subscriptionId: occurrence.subscription_id,
      type: "renew",
      effectiveOn: occurrence.term_ends_on,
      renewalTermMonths: occurrence.snapshot.policy.term_months,
      idempotencyKey: `renewal-document:${documentId}:term`,
      reason,
    });
    for (const [, c] of occurrence.snapshot.components.entries()) {
      const price = renewalUnitPrice(c.unit_price, occurrence.snapshot.policy.uplift_percent);
      await applyAmendment(orgId, actorId, {
        subscriptionId: occurrence.subscription_id,
        type: "change_component",
        componentKey: c.component_key,
        effectiveOn: occurrence.term_ends_on,
        quantity: c.quantity,
        unitPrice: price,
        idempotencyKey: `renewal-document:${documentId}:component:${c.component_key}`,
        reason,
      });
    }
    if (
      !(
        await db.execute(
          sql`insert into subscription_renewal_occurrences(org_id,policy_id,subscription_id,term_ends_on,occurrence,document_id,snapshot,actor_id)
      values(${orgId},${occurrence.policy_id},${occurrence.subscription_id},${occurrence.term_ends_on},'acceptance',${documentId},${JSON.stringify({ reason, source: occurrence.snapshot })}::jsonb,${actorId}) returning id`,
          "objects",
        )
      )[0]
    )
      throw new AdvancedSubscriptionError("Renewal acceptance evidence could not be saved");
    return { subscriptionId: occurrence.subscription_id };
  });
}

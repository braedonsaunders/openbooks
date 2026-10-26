import { sql } from "drizzle-orm";
import { db, withOrg } from "../platform/db.ts";
import { businessToday, isIsoCalendarDate } from "../platform/business-date.ts";
import { type AcceptanceProvider } from "./acceptance.ts";
import {
  AutopayError,
  parseExpiryNoticeDays,
  resolveAutopayPolicy,
  requireAutopayFeature,
  auditAutopay,
} from "./autopay-policy.ts";
import { ScopeNotFoundError, subsidiaryVisibleFilter } from "../organization/subsidiary-scope.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";

/** Automated collection retains its enrollment author and rechecks current receipt authority. */
export async function lockAutopayEnrollmentAuthority(
  orgId: string,
  enrollmentId: string,
  subsidiaryId: string | null,
) {
  const enrollment = (
    await db.execute<{ created_by: string | null }>(
      sql`
    select created_by from autopay_enrollments where org_id=${orgId} and id=${enrollmentId} for share`,
      "objects",
    )
  )[0];
  if (!enrollment?.created_by)
    throw new AutopayError(
      "Autopay has no enrollment author. Cancel that enrollment and enroll the customer with an authorized Receipts operator before retrying collection.",
    );
  let allowedSubsidiaryIds: ReadonlySet<string> | null;
  try {
    allowedSubsidiaryIds = await lockActorCommandAuthority(
      db,
      orgId,
      enrollment.created_by,
      subsidiaryId,
      "ar.pay",
    );
  } catch (cause) {
    if (!(cause instanceof ScopeNotFoundError)) throw cause;
    throw new AutopayError(
      "The enrollment author is inactive or lacks Receipts permission for this legal entity. Restore that user's permission and entity access before retrying the collection.",
      { cause },
    );
  }
  return { actorId: enrollment.created_by, allowedSubsidiaryIds };
}

/** Autopay enrollment lifecycle (enroll, pause, resume, cancel) and the expiring-card outreach scan. */

export interface AutopayEnrollment {
  id: string;
  partyId: string;
  subscriptionId: string | null;
  paymentMethodId: string | null;
  status: string;
  chargeOnIssue: boolean;
}

/**
 * Enroll a customer — or one subscription — in autopay. The method defaults
 * to the customer's default; subscription scope additionally requires the
 * method to belong to the subscription's customer, so one subscription can
 * never charge another customer's card.
 */
export async function enrollAutopay(
  orgId: string,
  input: {
    partyId: string;
    subscriptionId?: string | null;
    paymentMethodId?: string | null;
    chargeOnIssue?: boolean;
    actorId?: string | null;
  },
): Promise<AutopayEnrollment> {
  return withOrg(orgId, async () => {
    await requireAutopayFeature(orgId);
    if (input.subscriptionId) {
      const sub = (
        await db.execute<{ customer_id: string; status: string }>(
          sql`
        select customer_id, status from subscriptions
         where id = ${input.subscriptionId} and org_id = ${orgId} limit 1
      `,
          "objects",
        )
      )[0];
      if (!sub) throw new AutopayError("subscription not found");
      if (sub.status === "canceled")
        throw new AutopayError(
          "a canceled subscription cannot enroll in autopay; reactivate it first",
        );
      if (sub.customer_id !== input.partyId) {
        throw new AutopayError(
          "the subscription belongs to a different customer; enroll that customer instead",
        );
      }
    } else {
      const party = (
        await db.execute<{ id: string }>(
          sql`
        select id from parties where id = ${input.partyId} and org_id = ${orgId} limit 1
      `,
          "objects",
        )
      )[0];
      if (!party)
        throw new AutopayError("customer not found; pick a customer from Customers first");
    }
    let methodId = input.paymentMethodId ?? null;
    if (methodId) {
      const method = (
        await db.execute<{ party_id: string; status: string }>(
          sql`
        select party_id, status from customer_payment_methods
         where id = ${methodId} and org_id = ${orgId} limit 1
      `,
          "objects",
        )
      )[0];
      if (!method || method.status !== "active")
        throw new AutopayError("that payment method is not active; finish its setup first");
      if (method.party_id !== input.partyId) {
        throw new AutopayError(
          "that method belongs to a different customer; use one of this customer's methods",
        );
      }
    } else {
      methodId =
        (
          await db.execute<{ id: string }>(
            sql`
        select id from customer_payment_methods
         where org_id = ${orgId} and party_id = ${input.partyId} and status = 'active' and is_default
         limit 1
      `,
            "objects",
          )
        )[0]?.id ?? null;
    }
    const inserted = (
      await db.execute<{ id: string }>(
        sql`
      insert into autopay_enrollments (org_id, party_id, subscription_id, payment_method_id, status, charge_on_issue, created_by, updated_by)
      values (${orgId}, ${input.partyId}, ${input.subscriptionId ?? null}, ${methodId},
              'active', ${input.chargeOnIssue ?? false}, ${input.actorId ?? null}, ${input.actorId ?? null})
      returning id
    `,
        "objects",
      )
    )[0];
    if (!inserted) throw new AutopayError("enrollment could not be created; try again");
    await auditAutopay(
      orgId,
      "autopay_enrollments",
      inserted.id,
      {
        event: "enrolled",
        after: {
          subscriptionId: input.subscriptionId ?? null,
          chargeOnIssue: input.chargeOnIssue ?? false,
        },
        reason: input.subscriptionId
          ? "Subscription enrolled in autopay; due invoices charge automatically."
          : "Customer enrolled in autopay; due invoices charge automatically.",
      },
      input.actorId ?? null,
    );
    return {
      id: inserted.id,
      partyId: input.partyId,
      subscriptionId: input.subscriptionId ?? null,
      paymentMethodId: methodId,
      status: "active",
      chargeOnIssue: input.chargeOnIssue ?? false,
    };
  }).catch((error: unknown) => {
    // A live duplicate enrollment means this exact scope is already covered:
    // report the existing coverage instead of a constraint code. The pg code
    // rides on the driver's cause — DrizzleQueryError itself carries none.
    const pgCode =
      (error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code;
    if (pgCode === "23505") {
      throw new AutopayError(
        input.subscriptionId
          ? "this subscription is already enrolled in autopay"
          : "this customer is already enrolled in autopay; pause or cancel the existing enrollment first",
      );
    }
    throw error;
  });
}

async function setEnrollmentStatus(
  orgId: string,
  enrollmentId: string,
  status: "active" | "paused" | "canceled",
  actorId: string | null,
  reason: string,
): Promise<void> {
  return withOrg(orgId, async () => {
    await requireAutopayFeature(orgId);
    const flipped = await db.execute<{ id: string }>(
      sql`
      update autopay_enrollments set status = ${status}, updated_at = now(), updated_by = ${actorId}
       where id = ${enrollmentId} and org_id = ${orgId} and status <> ${status}
       returning id
    `,
      "objects",
    );
    if (!flipped[0]) throw new AutopayError("enrollment not found or already in that state");
    await auditAutopay(
      orgId,
      "autopay_enrollments",
      enrollmentId,
      { event: `enrollment_${status}`, reason },
      actorId,
    );
  });
}

export async function pauseEnrollment(
  orgId: string,
  enrollmentId: string,
  actorId: string | null = null,
): Promise<void> {
  return setEnrollmentStatus(
    orgId,
    enrollmentId,
    "paused",
    actorId,
    "Operator paused autopay; due invoices stay manual until resumed.",
  );
}

export async function resumeEnrollment(
  orgId: string,
  enrollmentId: string,
  actorId: string | null = null,
): Promise<void> {
  return setEnrollmentStatus(orgId, enrollmentId, "active", actorId, "Operator resumed autopay.");
}

export async function cancelEnrollment(
  orgId: string,
  enrollmentId: string,
  actorId: string | null = null,
): Promise<void> {
  return setEnrollmentStatus(
    orgId,
    enrollmentId,
    "canceled",
    actorId,
    "Operator canceled autopay; the customer returns to manual payment.",
  );
}

export interface ExpiringCard {
  methodId: string;
  partyId: string;
  partyName: string | null;
  provider: AcceptanceProvider;
  brand: string | null;
  last4: string | null;
  expMonth: number;
  expYear: number;
  /** End-of-month expiry date (civil). */
  expiresOn: string;
}

/**
 * Cards whose end-of-month expiry falls inside the outreach window — from
 * today through today + the policy's notice days — that have not been
 * notified yet. The queue feeds pre-expiry outreach: the operator sends each
 * customer a setup link to replace the card before it declines.
 */
export async function findCardsExpiringSoon(
  orgId: string,
  opts: { allowedSubsidiaryIds: ReadonlySet<string> | null; asOf?: string; withinDays?: number },
): Promise<ExpiringCard[]> {
  return withOrg(orgId, async () => {
    const asOf = opts?.asOf ?? (await businessToday(orgId));
    const withinDays =
      opts?.withinDays === undefined
        ? (await resolveAutopayPolicy(orgId)).expiryNoticeDays
        : parseExpiryNoticeDays(opts.withinDays);
    const rows = await db.execute<{
      methodId: string;
      partyId: string;
      partyName: string | null;
      provider: AcceptanceProvider;
      brand: string | null;
      last4: string | null;
      expMonth: number;
      expYear: number;
      expiresOn: string;
    }>(
      sql`
      select m.id as "methodId", m.party_id as "partyId", p.display_name as "partyName",
             m.provider, m.brand, m.last4, m.exp_month as "expMonth", m.exp_year as "expYear",
             ((make_date(m.exp_year, m.exp_month, 1) + interval '1 month' - interval '1 day')::date)::text as "expiresOn"
        from customer_payment_methods m
        join parties p on p.id = m.party_id and p.org_id = m.org_id
       where m.org_id = ${orgId} and m.status = 'active'
         ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, opts.allowedSubsidiaryIds, { orgWideNull: true })}
         and m.exp_month is not null and m.exp_year is not null
         and m.expiry_notified_on is null
         and (make_date(m.exp_year, m.exp_month, 1) + interval '1 month' - interval '1 day')::date
             between ${asOf}::date and (${asOf}::date + ${withinDays}::integer)
       order by (make_date(m.exp_year, m.exp_month, 1) + interval '1 month' - interval '1 day')::date, p.display_name
    `,
      "objects",
    );
    return rows.map((row) => ({
      methodId: row.methodId,
      partyId: row.partyId,
      partyName: row.partyName,
      provider: row.provider,
      brand: row.brand,
      last4: row.last4,
      expMonth: row.expMonth,
      expYear: row.expYear,
      expiresOn: row.expiresOn,
    }));
  });
}

/**
 * Stamp outreach as sent for the given cards. Every id must still be an
 * active, un-notified method — a short count means cards left the queue
 * (removed or already notified) and the operator refreshes it instead of
 * recording outreach nobody can act on.
 */
export async function markExpiryOutreachSent(
  orgId: string,
  methodIds: string[],
  sentOn: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  actorId: string | null = null,
): Promise<void> {
  if (!isIsoCalendarDate(sentOn))
    throw new AutopayError("outreach date must be a valid calendar date in YYYY-MM-DD format");
  if (methodIds.length === 0)
    throw new AutopayError("no cards were selected; pick the expiring cards first");
  return withOrg(orgId, async () => {
    await requireAutopayFeature(orgId);
    let stamped = 0;
    for (const methodId of methodIds) {
      const row = await db.execute<{ id: string }>(
        sql`
        update customer_payment_methods m
           set expiry_notified_on = ${sentOn}::date, updated_at = now(), updated_by = ${actorId}
          from parties p
         where m.id = ${methodId} and m.org_id = ${orgId} and m.status = 'active' and m.expiry_notified_on is null
           and p.org_id = m.org_id and p.id = m.party_id
           ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })}
         returning m.id
      `,
        "objects",
      );
      stamped += row.length;
    }
    if (stamped !== methodIds.length) {
      throw new AutopayError(
        "some cards left the queue before outreach went out (removed or already notified); refresh the expiring-cards queue and retry",
      );
    }
  });
}

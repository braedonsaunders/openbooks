/**
 * Customer visit notices: the arrival window when a visit is booked and the
 * on-my-way notice when the technician leaves, sent through the
 * organization's native email delivery when its dispatch policy opts in.
 *
 * Each notice is claimed once per visit, kind and booking (queued), sent
 * outside the claiming transaction, and then recorded as sent or failed, so
 * a retry never sends the same notice twice and an interrupted send stays
 * visible as queued.
 */
import { sql } from "drizzle-orm";
import {
  deriveEmailDeliveryKey,
  emailDeliveryBlockedParts,
  sendVia,
  serviceVisitArrivalWindowEmail,
  serviceVisitOnTheWayEmail,
} from "@openbooks/emails";
import { db, withOrgTransaction } from "../platform/db.ts";
import {
  insertEmailLog,
  markEmailFailed,
  markEmailSent,
  markEmailUncertain,
  resolveOrgEmailTransportDetailed,
} from "../delivery/email-config.ts";
import { localTimeFields } from "../platform/time-zone.ts";
import { businessTimeZoneInTx } from "../platform/business-date.ts";
import { actorRef, lockServiceFeature, requireOne, type ServiceActor } from "./common.ts";
import { policyOn } from "./policy.ts";

export interface CustomerNoticeRequest {
  readonly visitId: string;
  readonly kind: "arrival_window" | "en_route";
  /** One notice per occurrence: the booking revision or status move it announces. */
  readonly occurrenceKey: string;
}

export interface CustomerNoticeOutcome {
  readonly visitId: string;
  readonly kind: CustomerNoticeRequest["kind"];
  readonly status: "sent" | "suppressed" | "failed" | "queued" | "not_enabled";
  readonly detail: string | null;
}

type NoticeContext = {
  status: string;
  jobNumber: string | null;
  requestNumber: string | null;
  title: string;
  customerName: string;
  customerEmail: string | null;
  contactName: string | null;
  contactEmail: string | null;
  address: string | null;
  windowStartsAt: string | null;
  windowEndsAt: string | null;
  firstStartsAt: string | null;
  technicians: string[] | null;
  orgName: string;
  locale: string | null;
};

function windowLabel(locale: string, timeZone: string, startsAt: string, endsAt: string): string {
  const day = new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const time = new Intl.DateTimeFormat(locale, { timeZone, hour: "numeric", minute: "2-digit" });
  const sameDay =
    localTimeFields(startsAt, timeZone)?.date === localTimeFields(endsAt, timeZone)?.date;
  return sameDay
    ? `${day.format(new Date(startsAt))}, ${time.format(new Date(startsAt))} – ${time.format(new Date(endsAt))}`
    : `${day.format(new Date(startsAt))} ${time.format(new Date(startsAt))} – ${day.format(new Date(endsAt))} ${time.format(new Date(endsAt))}`;
}

async function claimNotice(actor: ServiceActor, notice: CustomerNoticeRequest) {
  return withOrgTransaction(actor.orgId, async () => {
    await lockServiceFeature(actor.orgId);
    const timeZone = await businessTimeZoneInTx(db, actor.orgId);
    const context = (
      await db.execute<NoticeContext>(
        sql`select v.status, j.job_number as "jobNumber", r.request_number as "requestNumber",
        coalesce(j.title, r.title) as title, p.display_name as "customerName", nullif(btrim(p.email), '') as "customerEmail",
        coalesce(c.name, nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), '')) as "contactName", nullif(btrim(c.email), '') as "contactEmail",
        nullif(concat_ws(', ', a.line1, a.line2, a.city, a.region, a.postal_code), '') as address,
        to_char(v.window_starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "windowStartsAt",
        to_char(v.window_ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "windowEndsAt",
        (select to_char(min(e.starts_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') from schedule_entries e
          where e.org_id = v.org_id and e.service_visit_id = v.id and e.status = 'published') as "firstStartsAt",
        (select array_agg(t.display_name order by e.starts_at) from schedule_entries e join parties t on t.org_id = e.org_id and t.id = e.worker_party_id
          where e.org_id = v.org_id and e.service_visit_id = v.id and e.status = 'published') as technicians,
        o.name as "orgName", o.settings->>'defaultLocale' as locale
      from service_visits v
      left join service_jobs j on j.org_id = v.org_id and j.id = v.job_id
      left join service_requests r on r.org_id = v.org_id and r.id = v.request_id
      join parties p on p.org_id = v.org_id and p.id = coalesce(j.customer_party_id, r.customer_party_id)
      left join contacts c on c.org_id = v.org_id and c.id = coalesce(j.contact_id, r.contact_id)
      left join addresses a on a.org_id = v.org_id and a.id = coalesce(j.service_address_id, r.service_address_id)
      join orgs o on o.id = v.org_id
      where v.org_id = ${actor.orgId} and v.id = ${notice.visitId}`,
        "objects",
      )
    )[0];
    if (!context)
      return {
        done: { status: "suppressed" as const, detail: "The visit is no longer available." },
      };
    const anchor = context.firstStartsAt ?? new Date().toISOString();
    const policy = await policyOn(
      actor.orgId,
      localTimeFields(anchor, timeZone)?.date ?? anchor.slice(0, 10),
    );
    const enabled =
      notice.kind === "en_route"
        ? policy?.notifyEnRoute === true
        : policy?.notifyArrivalWindow === true;
    if (!enabled) return { done: { status: "not_enabled" as const, detail: null } };
    await db.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`service-notice:${actor.orgId}:${notice.visitId}:${notice.kind}:${notice.occurrenceKey}`}, 0))`,
    );
    const existing = (
      await db.execute<{ status: CustomerNoticeOutcome["status"]; detail: string | null }>(
        sql`select status, detail from service_customer_notices
      where org_id = ${actor.orgId} and visit_id = ${notice.visitId} and kind = ${notice.kind} and occurrence_key = ${notice.occurrenceKey}`,
        "objects",
      )
    )[0];
    if (existing) return { done: existing };
    const record = async (
      status: "suppressed" | "queued",
      detail: string | null,
      recipient: string | null,
      emailLogId: string | null,
    ) =>
      requireOne(
        await db.execute<{ id: string }>(
          sql`insert into service_customer_notices (org_id, visit_id, kind, occurrence_key, recipient, status, detail, email_log_id, created_by)
        values (${actor.orgId}, ${notice.visitId}, ${notice.kind}, ${notice.occurrenceKey}, ${recipient}, ${status}, ${detail}, ${emailLogId}, ${actorRef(actor)}) returning id`,
          "objects",
        ),
        "The customer notice",
      ).id;
    const to = context.contactEmail ?? context.customerEmail;
    if (!to) {
      const detail = "No email address on the site contact or the customer record.";
      await record("suppressed", detail, null, null);
      return { done: { status: "suppressed" as const, detail } };
    }
    const delivery = await resolveOrgEmailTransportDetailed(actor.orgId);
    if (delivery.state !== "ready") {
      const parts = emailDeliveryBlockedParts(delivery);
      const detail = `${parts.summary} ${parts.remedy}`.trim();
      await record("suppressed", detail, to, null);
      return { done: { status: "suppressed" as const, detail } };
    }
    const locale = context.locale?.trim() || "en";
    const number = context.jobNumber ?? context.requestNumber ?? "";
    let email;
    if (notice.kind === "arrival_window") {
      const startsAt = context.windowStartsAt ?? context.firstStartsAt;
      const endsAt = context.windowEndsAt ?? context.firstStartsAt;
      if (!startsAt || !endsAt) {
        const detail = "The visit has no booking or arrival window to announce.";
        await record("suppressed", detail, to, null);
        return { done: { status: "suppressed" as const, detail } };
      }
      email = serviceVisitArrivalWindowEmail({
        orgName: context.orgName,
        recipientName: context.contactName ?? context.customerName,
        jobNumber: number,
        jobTitle: context.title,
        serviceAddress: context.address,
        windowLabel: `between ${windowLabel(locale, timeZone, startsAt, endsAt)}`,
        technicianNames: context.technicians ?? [],
      });
    } else {
      const arrival =
        context.windowStartsAt && context.windowEndsAt
          ? windowLabel(locale, timeZone, context.windowStartsAt, context.windowEndsAt)
          : null;
      email = serviceVisitOnTheWayEmail({
        orgName: context.orgName,
        recipientName: context.contactName ?? context.customerName,
        jobNumber: number,
        jobTitle: context.title,
        technicianName: context.technicians?.[0] ?? null,
        arrivalLabel: arrival,
      });
    }
    const logId = await insertEmailLog({
      orgId: actor.orgId,
      recipients: [to],
      subject: email.subject,
      status: "queued",
      categoryKey: "service",
      meta: { recordType: "service_visit", recordId: notice.visitId, event: notice.kind },
      actor: actorRef(actor)
        ? { kind: "user", userId: actor.actorId }
        : { kind: "system", reason: "service visit notice" },
    });
    const noticeId = await record("queued", null, to, logId);
    return { send: { to, email, logId, noticeId, transport: delivery.transport } };
  });
}

/** Send one customer notice when the dispatch policy opts in. Delivery failure never undoes the visit change that caused it. */
export async function deliverCustomerNotice(
  actor: ServiceActor,
  notice: CustomerNoticeRequest,
): Promise<CustomerNoticeOutcome> {
  const claim = await claimNotice(actor, notice);
  if ("done" in claim && claim.done)
    return {
      visitId: notice.visitId,
      kind: notice.kind,
      status: claim.done.status,
      detail: claim.done.detail,
    };
  const { to, email, logId, noticeId, transport } = claim.send!;
  let status: "sent" | "failed" = "failed";
  let detail: string | null = null;
  try {
    const outcome = await sendVia(
      transport,
      { to, subject: email.subject, html: email.html, text: email.text },
      {
        deliveryKey: deriveEmailDeliveryKey({ orgId: actor.orgId, scope: `direct:${logId}`, to }),
      },
    );
    if (outcome.kind === "sent") {
      status = "sent";
      await withOrgTransaction(actor.orgId, () =>
        markEmailSent(actor.orgId, logId, outcome.providerMessageId),
      );
    } else {
      detail = outcome.reason;
      await withOrgTransaction(actor.orgId, () =>
        markEmailUncertain(actor.orgId, logId, outcome.reason),
      );
      // An uncertain send stays queued until delivery is reconciled; it is never re-sent blindly.
      return { visitId: notice.visitId, kind: notice.kind, status: "queued", detail };
    }
  } catch (error) {
    detail = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
    await withOrgTransaction(actor.orgId, () => markEmailFailed(actor.orgId, logId, detail!));
  }
  await withOrgTransaction(actor.orgId, async () => {
    requireOne(
      await db.execute(
        sql`update service_customer_notices set status = ${status}, detail = ${detail}
      where org_id = ${actor.orgId} and id = ${noticeId} and status = 'queued' returning id`,
        "objects",
      ),
      "The customer notice outcome",
    );
  });
  return { visitId: notice.visitId, kind: notice.kind, status, detail };
}

/** Deliver every notice a committed command produced, in order. */
export async function deliverCustomerNotices(
  actor: ServiceActor,
  notices: readonly CustomerNoticeRequest[],
): Promise<CustomerNoticeOutcome[]> {
  const out: CustomerNoticeOutcome[] = [];
  for (const notice of notices) out.push(await deliverCustomerNotice(actor, notice));
  return out;
}

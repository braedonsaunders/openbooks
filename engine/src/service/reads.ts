/**
 * Read models for the service surfaces: request, job, visit and agreement
 * detail, the technician's own visits, and the service home summary. Staff
 * reads need a service read grant in the record's legal entity; a
 * technician reads only visits booked on them, without prices.
 */
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { businessTodayInTx } from "../platform/business-date.ts";
import { actorHasPermission } from "../organization/actor-permissions.ts";
import { ScopeNotFoundError, subsidiaryVisibleFilter } from "../organization/subsidiary-scope.ts";
import {
  holdsServicePermission,
  lockServiceFeature,
  requireDate,
  requireUuid,
  serviceAuthority,
  technicianParty,
  type ServiceActor,
} from "./common.ts";
import { serviceDatabaseRefusal } from "./errors.ts";
import { nextVisitStatuses, type VisitStatus } from "./status.ts";
import { requestColumns, type StoredRequest } from "./requests.ts";
import { JOB_COLUMNS, type StoredJob } from "./jobs.ts";
import {
  STORED_VISIT_COLUMNS,
  STORED_VISIT_JOINS,
  visitFieldAuthority,
  type StoredVisit,
} from "./visits.ts";

const INSTANT = (column: ReturnType<typeof sql>) =>
  sql`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export type VisitTechnician = {
  readonly entryId: string;
  readonly revision: number;
  readonly partyId: string;
  readonly name: string;
  readonly boardId: string;
  readonly boardName: string;
  readonly startsAt: string;
  readonly endsAt: string;
};

export type ServiceStockLocationOption = { id: string; code: string; name: string };

/** Active owned stock locations visible to the caller's legal entities. */
export async function listServiceStockLocations(
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<ServiceStockLocationOption[]> {
  return await db.execute<ServiceStockLocationOption>(
    sql`select sl.id, sl.code, coalesce(l.name, sl.code) as name
      from stock_locations sl join locations l on l.org_id = sl.org_id and l.id = sl.location_id
     where sl.org_id = ${orgId} and sl.is_active and sl.kind <> 'subcontract' and sl.inventory_ownership = 'owned'
       ${subsidiaryVisibleFilter(sql`l.subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })}
     order by l.name nulls last, sl.code, sl.id`,
    "objects",
  );
}

export type VisitSummary = {
  readonly id: string;
  readonly revision: number;
  readonly kind: "assessment" | "service";
  readonly sequence: number;
  readonly status: VisitStatus;
  readonly priority: string;
  readonly estimatedMinutes: number;
  readonly preferredOn: string | null;
  readonly occursOn: string | null;
  readonly windowStartsAt: string | null;
  readonly windowEndsAt: string | null;
  readonly slaDueAt: string | null;
  readonly completedAt: string | null;
  readonly reviewStatus: string | null;
  readonly technicians: readonly VisitTechnician[];
  readonly invoice: {
    readonly id: string;
    readonly documentNumber: string;
    readonly status: string;
  } | null;
};

const VISIT_SUMMARY_COLUMNS = sql`v.id, v.revision, v.kind, v.sequence, v.status, v.priority, v.estimated_minutes as "estimatedMinutes", v.preferred_on::text as "preferredOn",
  v.occurs_on::text as "occursOn", ${INSTANT(sql`v.window_starts_at`)} as "windowStartsAt", ${INSTANT(sql`v.window_ends_at`)} as "windowEndsAt",
  ${INSTANT(sql`v.sla_due_at`)} as "slaDueAt", ${INSTANT(sql`v.completed_at`)} as "completedAt", v.review_status as "reviewStatus",
  coalesce((select jsonb_agg(jsonb_build_object('entryId', e.id, 'revision', e.revision, 'partyId', e.worker_party_id, 'name', t.display_name, 'boardId', e.board_id,
      'boardName', b.name, 'startsAt', ${INSTANT(sql`e.starts_at`)}, 'endsAt', ${INSTANT(sql`e.ends_at`)}) order by e.starts_at, t.display_name)
    from schedule_entries e join parties t on t.org_id = e.org_id and t.id = e.worker_party_id join schedule_boards b on b.org_id = e.org_id and b.id = e.board_id
    where e.org_id = v.org_id and e.service_visit_id = v.id and e.status = 'published'), '[]'::jsonb) as technicians,
  (select jsonb_build_object('id', d.id, 'documentNumber', d.document_number, 'status', d.status) from service_billings sb
    join documents d on d.org_id = sb.org_id and d.id = sb.invoice_document_id
    where sb.org_id = v.org_id and sb.visit_id = v.id and sb.released_at is null limit 1) as invoice`;

async function visitSummaries(
  orgId: string,
  filter: ReturnType<typeof sql>,
): Promise<VisitSummary[]> {
  return await db.execute<VisitSummary>(
    sql`select ${VISIT_SUMMARY_COLUMNS} from service_visits v where v.org_id = ${orgId} and ${filter}
    order by coalesce(v.occurs_on, v.preferred_on), v.sequence`,
    "objects",
  );
}

export type ServiceParty = {
  readonly customerName: string;
  readonly customerEmail: string | null;
  readonly customerPhone: string | null;
  readonly address: string | null;
  readonly contactName: string | null;
  readonly contactEmail: string | null;
  readonly contactPhone: string | null;
  readonly subsidiaryName: string | null;
};

const PARTY_COLUMNS = (
  customer: ReturnType<typeof sql>,
  address: ReturnType<typeof sql>,
  contact: ReturnType<typeof sql>,
  subsidiary: ReturnType<typeof sql>,
) => sql`
  (select display_name from parties where org_id = x.org_id and id = ${customer}) as "customerName",
  (select nullif(btrim(email), '') from parties where org_id = x.org_id and id = ${customer}) as "customerEmail",
  (select nullif(btrim(phone), '') from parties where org_id = x.org_id and id = ${customer}) as "customerPhone",
  (select nullif(concat_ws(', ', a.line1, a.line2, a.city, a.region, a.postal_code, a.country), '') from addresses a where a.org_id = x.org_id and a.id = ${address}) as address,
  (select coalesce(c.name, nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), '')) from contacts c where c.org_id = x.org_id and c.id = ${contact}) as "contactName",
  (select nullif(btrim(c.email), '') from contacts c where c.org_id = x.org_id and c.id = ${contact}) as "contactEmail",
  (select coalesce(nullif(btrim(c.mobile_phone), ''), nullif(btrim(c.phone), '')) from contacts c where c.org_id = x.org_id and c.id = ${contact}) as "contactPhone",
  (select name from subsidiaries where org_id = x.org_id and id = ${subsidiary}) as "subsidiaryName"`;

export type ServiceQuoteSummary = {
  readonly quoteDocumentId: string;
  readonly documentNumber: string;
  readonly estimateStatus: string;
  readonly status: "draft" | "sent" | "accepted" | "declined";
  readonly depositBasis: string;
  readonly depositValue: string;
  readonly acceptedTotal: string | null;
  readonly depositDue: string | null;
  readonly total: string;
  readonly currency: string;
  readonly sentAt: string | null;
  readonly decidedAt: string | null;
  readonly decidedName: string | null;
  readonly signatureStatus: string | null;
  readonly expiresAt: string | null;
  readonly jobId: string | null;
  readonly revision: number;
  readonly optionalLineIds: readonly string[];
};

const QUOTE_SUMMARY = sql`q.quote_document_id as "quoteDocumentId", d.document_number as "documentNumber", d.status as "estimateStatus", q.status,
  q.deposit_basis as "depositBasis", q.deposit_value::text as "depositValue", q.accepted_total::text as "acceptedTotal", q.deposit_due::text as "depositDue",
  d.total::text as total, d.currency, ${INSTANT(sql`q.sent_at`)} as "sentAt", ${INSTANT(sql`q.decided_at`)} as "decidedAt", q.decided_name as "decidedName",
  sr.status as "signatureStatus", ${INSTANT(sql`sr.expires_at`)} as "expiresAt", q.job_id as "jobId", q.revision,
  coalesce((select array_agg(ql.document_line_id::text) from service_quote_lines ql where ql.org_id = q.org_id and ql.quote_document_id = q.quote_document_id and ql.optional), '{}'::text[]) as "optionalLineIds"`;

const QUOTE_JOINS = sql`from service_quotes q join documents d on d.org_id = q.org_id and d.id = q.quote_document_id
  left join signature_requests sr on sr.org_id = q.org_id and sr.id = q.signature_request_id`;

export interface ServiceRequestDetail {
  readonly request: StoredRequest & ServiceParty & { readonly closeReason: string | null };
  readonly visits: readonly VisitSummary[];
  readonly quotes: readonly ServiceQuoteSummary[];
  readonly job: { readonly id: string; readonly jobNumber: string; readonly status: string } | null;
  readonly canManage: boolean;
}

export async function getServiceRequest(
  actor: ServiceActor & { requestId: string },
): Promise<ServiceRequestDetail> {
  return withOrgTransaction(actor.orgId, async () => {
    await lockServiceFeature(actor.orgId);
    const row = (
      await db.execute<StoredRequest & ServiceParty & { closeReason: string | null }>(
        sql`select ${requestColumns(sql`x`)}, x.close_reason as "closeReason",
        ${PARTY_COLUMNS(sql`x.customer_party_id`, sql`x.service_address_id`, sql`x.contact_id`, sql`x.subsidiary_id`)}
      from service_requests x where x.org_id = ${actor.orgId} and x.id = ${requireUuid(actor.requestId, "Request")}`,
        "objects",
      )
    )[0];
    if (!row) throw new ScopeNotFoundError();
    await serviceAuthority(actor, "service.read", row.subsidiaryId);
    const visits = await visitSummaries(actor.orgId, sql`v.request_id = ${row.id}`);
    const quotes = await db.execute<ServiceQuoteSummary>(
      sql`select ${QUOTE_SUMMARY} ${QUOTE_JOINS} where q.org_id = ${actor.orgId} and q.request_id = ${row.id} order by q.created_at`,
      "objects",
    );
    const job = row.jobId
      ? ((
          await db.execute<{ id: string; jobNumber: string; status: string }>(
            sql`select id, job_number as "jobNumber", status from service_jobs where org_id = ${actor.orgId} and id = ${row.jobId}`,
            "objects",
          )
        )[0] ?? null)
      : null;
    return {
      request: row,
      visits,
      quotes,
      job,
      canManage: await holdsServicePermission(actor, "service.manage"),
    };
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(error);
  });
}

export interface ServiceJobDetail {
  readonly job: StoredJob &
    ServiceParty & {
      readonly requestNumber: string | null;
      readonly quoteNumber: string | null;
      readonly agreementNumber: string | null;
      readonly laborItemName: string | null;
      readonly closeReason: string | null;
      readonly completedAt: string | null;
    };
  readonly lines: readonly {
    readonly lineNumber: number;
    readonly itemId: string;
    readonly itemName: string;
    readonly description: string | null;
    readonly quantity: string;
    readonly unitPrice: string;
    readonly taxCodeId: string | null;
    readonly sourceQuoteLineId: string | null;
  }[];
  readonly visits: readonly VisitSummary[];
  readonly deposits: readonly {
    readonly id: string;
    readonly paymentDocumentId: string;
    readonly documentNumber: string;
    readonly amount: string;
    readonly createdAt: string;
  }[];
  readonly billings: readonly {
    readonly id: string;
    readonly visitId: string | null;
    readonly invoiceId: string;
    readonly documentNumber: string;
    readonly status: string;
    readonly total: string;
    readonly releasedAt: string | null;
  }[];
  readonly quote: ServiceQuoteSummary | null;
  readonly canManage: boolean;
  readonly canInvoice: boolean;
}

export async function getServiceJob(
  actor: ServiceActor & { jobId: string },
): Promise<ServiceJobDetail> {
  return withOrgTransaction(actor.orgId, async () => {
    await lockServiceFeature(actor.orgId);
    const job = (
      await db.execute<ServiceJobDetail["job"]>(
        sql`select ${JOB_COLUMNS}, close_reason as "closeReason", ${INSTANT(sql`completed_at`)} as "completedAt",
        (select request_number from service_requests r where r.org_id = x.org_id and r.id = x.request_id) as "requestNumber",
        (select document_number from documents d where d.org_id = x.org_id and d.id = x.quote_document_id) as "quoteNumber",
        (select agreement_number from service_agreements a where a.org_id = x.org_id and a.id = x.agreement_id) as "agreementNumber",
        (select name from items i where i.org_id = x.org_id and i.id = x.labor_item_id) as "laborItemName",
        ${PARTY_COLUMNS(sql`x.customer_party_id`, sql`x.service_address_id`, sql`x.contact_id`, sql`x.subsidiary_id`)}
      from service_jobs x where x.org_id = ${actor.orgId} and x.id = ${requireUuid(actor.jobId, "Job")}`,
        "objects",
      )
    )[0];
    if (!job) throw new ScopeNotFoundError();
    await serviceAuthority(actor, "service.read", job.subsidiaryId);
    const lines = await db.execute<ServiceJobDetail["lines"][number]>(
      sql`select l.line_number as "lineNumber", l.item_id as "itemId",
        coalesce(nullif(i.code, '') || ' — ', '') || i.name as "itemName", l.description, l.quantity::text, l.unit_price::text as "unitPrice", l.tax_code_id as "taxCodeId",
        l.source_quote_line_id as "sourceQuoteLineId"
      from service_job_lines l join items i on i.org_id = l.org_id and i.id = l.item_id where l.org_id = ${actor.orgId} and l.job_id = ${job.id} order by l.line_number`,
      "objects",
    );
    const visits = await visitSummaries(actor.orgId, sql`v.job_id = ${job.id}`);
    const deposits = await db.execute<ServiceJobDetail["deposits"][number]>(
      sql`select dep.id, dep.payment_document_id as "paymentDocumentId", d.document_number as "documentNumber",
        dep.amount::text, ${INSTANT(sql`dep.created_at`)} as "createdAt"
      from service_job_deposits dep join documents d on d.org_id = dep.org_id and d.id = dep.payment_document_id
      where dep.org_id = ${actor.orgId} and dep.job_id = ${job.id} order by dep.created_at`,
      "objects",
    );
    const billings = await db.execute<ServiceJobDetail["billings"][number]>(
      sql`select b.id, b.visit_id as "visitId", b.invoice_document_id as "invoiceId", d.document_number as "documentNumber",
        d.status, d.total::text as total, ${INSTANT(sql`b.released_at`)} as "releasedAt"
      from service_billings b join documents d on d.org_id = b.org_id and d.id = b.invoice_document_id
      where b.org_id = ${actor.orgId} and b.job_id = ${job.id} order by b.created_at`,
      "objects",
    );
    const quote = job.quoteDocumentId
      ? ((
          await db.execute<ServiceQuoteSummary>(
            sql`select ${QUOTE_SUMMARY} ${QUOTE_JOINS} where q.org_id = ${actor.orgId} and q.quote_document_id = ${job.quoteDocumentId}`,
            "objects",
          )
        )[0] ?? null)
      : null;
    const canManage = await holdsServicePermission(actor, "service.manage");
    return {
      job,
      lines,
      visits,
      deposits,
      billings,
      quote,
      canManage,
      canInvoice:
        canManage && (await actorHasPermission(db, actor.orgId, actor.actorId, "ar.create")),
    };
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(error);
  });
}

export interface ServiceVisitDetail {
  readonly visit: StoredVisit & {
    readonly instructions: string | null;
    readonly workNotes: string | null;
    readonly outcomeReason: string | null;
    readonly cancelKind: string | null;
    readonly dispatchedAt: string | null;
    readonly enRouteAt: string | null;
    readonly arrivedAt: string | null;
    readonly completedAt: string | null;
    readonly reviewReason: string | null;
  };
  readonly parent: ServiceParty & {
    readonly kind: "job" | "request";
    readonly id: string;
    readonly number: string;
    readonly title: string;
    readonly status: string;
    readonly billingMode: string | null;
  };
  readonly technicians: readonly VisitTechnician[];
  readonly events: readonly {
    readonly fromStatus: string | null;
    readonly toStatus: string;
    readonly occurredAt: string;
    readonly actorName: string | null;
    readonly workerName: string | null;
    readonly reason: string | null;
  }[];
  readonly parts: readonly {
    readonly id: string;
    readonly itemId: string;
    readonly itemName: string;
    readonly stockLocation: string;
    readonly quantity: string;
    readonly unitPrice: string | null;
    readonly billable: boolean;
    readonly issued: boolean;
    readonly memo: string | null;
  }[];
  readonly labor: readonly {
    readonly id: string;
    readonly workerName: string;
    readonly workedOn: string;
    readonly hours: string;
    readonly status: string;
    readonly billingStatus: string;
  }[];
  readonly signature: {
    readonly signerName: string;
    readonly signedAt: string;
    readonly fileId: string;
    readonly comment: string | null;
  } | null;
  readonly signatureLink: {
    readonly requestId: string;
    readonly recipient: string | null;
    readonly expiresAt: string;
  } | null;
  readonly notices: readonly {
    readonly kind: string;
    readonly status: string;
    readonly recipient: string | null;
    readonly detail: string | null;
    readonly createdAt: string;
  }[];
  readonly invoice: {
    readonly id: string;
    readonly documentNumber: string;
    readonly status: string;
  } | null;
  readonly mode: "staff" | "technician";
  readonly nextStatuses: readonly VisitStatus[];
  readonly canDispatch: boolean;
}

/** A visit with its work, history and sign-off. Technicians reading their own visit see no prices. */
export async function getServiceVisit(
  actor: ServiceActor & { visitId: string },
): Promise<ServiceVisitDetail> {
  return withOrgTransaction(actor.orgId, async () => {
    await lockServiceFeature(actor.orgId);
    const visit = (
      await db.execute<ServiceVisitDetail["visit"]>(
        sql`select ${STORED_VISIT_COLUMNS}, v.instructions, v.work_notes as "workNotes", v.outcome_reason as "outcomeReason",
        v.cancel_kind as "cancelKind", ${INSTANT(sql`v.dispatched_at`)} as "dispatchedAt", ${INSTANT(sql`v.en_route_at`)} as "enRouteAt",
        ${INSTANT(sql`v.arrived_at`)} as "arrivedAt", ${INSTANT(sql`v.completed_at`)} as "completedAt", v.review_reason as "reviewReason"
      ${STORED_VISIT_JOINS} where v.org_id = ${actor.orgId} and v.id = ${requireUuid(actor.visitId, "Visit")}`,
        "objects",
      )
    )[0];
    if (!visit) throw new ScopeNotFoundError();
    let mode: "staff" | "technician";
    if (
      (await holdsServicePermission(actor, "service.read")) ||
      (await holdsServicePermission(actor, "service.manage")) ||
      (await holdsServicePermission(actor, "service.dispatch"))
    ) {
      await serviceAuthority(actor, "service.read", visit.subsidiaryId);
      mode = "staff";
    } else {
      mode = (await visitFieldAuthority(actor, visit)).mode;
    }
    const parent = (
      await db.execute<ServiceVisitDetail["parent"]>(
        visit.jobId
          ? sql`select 'job' as kind, x.id, x.job_number as number, x.title, x.status, x.billing_mode as "billingMode",
          ${PARTY_COLUMNS(sql`x.customer_party_id`, sql`x.service_address_id`, sql`x.contact_id`, sql`x.subsidiary_id`)}
          from service_jobs x where x.org_id = ${actor.orgId} and x.id = ${visit.jobId}`
          : sql`select 'request' as kind, x.id, x.request_number as number, x.title, x.status, null::text as "billingMode",
          ${PARTY_COLUMNS(sql`x.customer_party_id`, sql`x.service_address_id`, sql`x.contact_id`, sql`x.subsidiary_id`)}
          from service_requests x where x.org_id = ${actor.orgId} and x.id = ${visit.requestId}`,
        "objects",
      )
    )[0]!;
    const technicians =
      (await visitSummaries(actor.orgId, sql`v.id = ${visit.id}`))[0]?.technicians ?? [];
    const events = await db.execute<ServiceVisitDetail["events"][number]>(
      sql`select ev.from_status as "fromStatus", ev.to_status as "toStatus", ${INSTANT(sql`ev.occurred_at`)} as "occurredAt",
        u.name as "actorName", w.display_name as "workerName", ev.reason
      from service_visit_events ev left join users u on u.org_id = ev.org_id and u.id = ev.actor_id left join parties w on w.org_id = ev.org_id and w.id = ev.worker_party_id
      where ev.org_id = ${actor.orgId} and ev.visit_id = ${visit.id} order by ev.visit_revision`,
      "objects",
    );
    const parts = await db.execute<ServiceVisitDetail["parts"][number]>(
      sql`select sp.id, sp.item_id as "itemId", coalesce(nullif(i.code, '') || ' — ', '') || i.name as "itemName",
        sl.code as "stockLocation", sp.quantity::text, ${mode === "staff" ? sql`sp.unit_price::text` : sql`null::text`} as "unitPrice", sp.billable,
        sp.inventory_movement_id is not null as issued, sp.memo
      from service_visit_parts sp join items i on i.org_id = sp.org_id and i.id = sp.item_id join stock_locations sl on sl.org_id = sp.org_id and sl.id = sp.stock_location_id
      where sp.org_id = ${actor.orgId} and sp.visit_id = ${visit.id} order by sp.created_at, sp.id`,
      "objects",
    );
    const labor = await db.execute<ServiceVisitDetail["labor"][number]>(
      sql`select te.id, p.display_name as "workerName", te.worked_on::text as "workedOn", te.hours::text,
        te.status, te.billing_status as "billingStatus"
      from time_entries te join parties p on p.org_id = te.org_id and p.id = te.employee_party_id
      where te.org_id = ${actor.orgId} and te.service_visit_id = ${visit.id} order by te.worked_on, te.id`,
      "objects",
    );
    const signature =
      (
        await db.execute<NonNullable<ServiceVisitDetail["signature"]>>(
          sql`select signer_name as "signerName", ${INSTANT(sql`signed_at`)} as "signedAt",
        signature_file_id as "fileId", comment from service_visit_signatures where org_id = ${actor.orgId} and visit_id = ${visit.id}`,
          "objects",
        )
      )[0] ?? null;
    const signatureLink =
      (
        await db.execute<NonNullable<ServiceVisitDetail["signatureLink"]>>(
          sql`select id as "requestId", recipient, ${INSTANT(sql`expires_at`)} as "expiresAt"
      from service_visit_signature_requests where org_id = ${actor.orgId} and visit_id = ${visit.id} and responded_at is null and revoked_at is null and expires_at > now()`,
          "objects",
        )
      )[0] ?? null;
    const notices =
      mode === "staff"
        ? await db.execute<ServiceVisitDetail["notices"][number]>(
            sql`select kind, status, recipient, detail, ${INSTANT(sql`created_at`)} as "createdAt"
      from service_customer_notices where org_id = ${actor.orgId} and visit_id = ${visit.id} order by created_at`,
            "objects",
          )
        : [];
    const invoice =
      mode === "staff"
        ? ((await visitSummaries(actor.orgId, sql`v.id = ${visit.id}`))[0]?.invoice ?? null)
        : null;
    const canDispatch =
      mode === "staff" && (await holdsServicePermission(actor, "service.dispatch"));
    return {
      visit,
      parent,
      technicians,
      events,
      parts,
      labor,
      signature,
      signatureLink,
      notices,
      invoice,
      mode,
      nextStatuses: nextVisitStatuses(visit.status, mode === "staff" ? "staff" : "technician"),
      canDispatch,
    };
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(error);
  });
}

export type MyVisit = {
  readonly id: string;
  readonly revision: number;
  readonly kind: "assessment" | "service";
  readonly status: VisitStatus;
  readonly priority: string;
  readonly number: string;
  readonly title: string;
  readonly customerName: string;
  readonly address: string | null;
  readonly contactName: string | null;
  readonly contactPhone: string | null;
  readonly instructions: string | null;
  readonly windowStartsAt: string | null;
  readonly windowEndsAt: string | null;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly partsCount: number;
  readonly signed: boolean;
  readonly nextStatuses: readonly VisitStatus[];
};

/** The technician's own visits in a date range, in booking order. */
export async function listMyVisits(
  actor: ServiceActor & { from: string; through: string },
): Promise<{ personName: string; visits: MyVisit[]; today: string }> {
  const from = requireDate(actor.from, "From");
  const through = requireDate(actor.through, "Through");
  return withOrgTransaction(actor.orgId, async () => {
    const partyId = await technicianParty(actor);
    const personName =
      (
        await db.execute<{ name: string }>(
          sql`select display_name as name from parties where org_id = ${actor.orgId} and id = ${partyId}`,
          "objects",
        )
      )[0]?.name ?? "";
    const rows = await db.execute<Omit<MyVisit, "nextStatuses">>(
      sql`select v.id, v.revision, v.kind, v.status, v.priority, coalesce(j.job_number, r.request_number) as number,
        coalesce(j.title, r.title) as title, p.display_name as "customerName",
        nullif(concat_ws(', ', a.line1, a.line2, a.city, a.region, a.postal_code), '') as address,
        coalesce(c.name, nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), '')) as "contactName",
        coalesce(nullif(btrim(c.mobile_phone), ''), nullif(btrim(c.phone), ''), nullif(btrim(p.phone), '')) as "contactPhone",
        v.instructions, ${INSTANT(sql`v.window_starts_at`)} as "windowStartsAt", ${INSTANT(sql`v.window_ends_at`)} as "windowEndsAt",
        ${INSTANT(sql`e.starts_at`)} as "startsAt", ${INSTANT(sql`e.ends_at`)} as "endsAt",
        (select count(*)::int from service_visit_parts sp where sp.org_id = v.org_id and sp.visit_id = v.id) as "partsCount",
        exists (select 1 from service_visit_signatures s where s.org_id = v.org_id and s.visit_id = v.id) as signed
      from schedule_entries e
      join service_visits v on v.org_id = e.org_id and v.id = e.service_visit_id
      left join service_jobs j on j.org_id = v.org_id and j.id = v.job_id
      left join service_requests r on r.org_id = v.org_id and r.id = v.request_id
      join parties p on p.org_id = v.org_id and p.id = coalesce(j.customer_party_id, r.customer_party_id)
      left join addresses a on a.org_id = v.org_id and a.id = coalesce(j.service_address_id, r.service_address_id)
      left join contacts c on c.org_id = v.org_id and c.id = coalesce(j.contact_id, r.contact_id)
      where e.org_id = ${actor.orgId} and e.worker_party_id = ${partyId} and e.status = 'published'
        and e.starts_on <= ${through} and e.ends_on >= ${from}
      order by e.starts_at, v.id`,
      "objects",
    );
    const today = await businessTodayInTx(db, actor.orgId);
    return {
      personName,
      today,
      visits: rows.map((row) => ({
        ...row,
        nextStatuses: nextVisitStatuses(row.status, "technician"),
      })),
    };
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(error);
  });
}

export interface ServiceAgreementDetail {
  readonly agreement: {
    readonly id: string;
    readonly revision: number;
    readonly agreementNumber: string;
    readonly title: string;
    readonly status: string;
    readonly startsOn: string;
    readonly endsOn: string | null;
    readonly jobId: string | null;
    readonly jobNumber: string | null;
    readonly generatedThrough: string | null;
    readonly subsidiaryId: string;
    readonly customerPartyId: string;
    readonly closeReason: string | null;
  } & ServiceParty;
  readonly versions: readonly {
    readonly id: string;
    readonly effectiveFrom: string;
    readonly recurrence: unknown;
    readonly windowStarts: string;
    readonly windowEnds: string;
    readonly estimatedMinutes: number;
    readonly priority: string;
    readonly requiredQualificationTypeIds: readonly string[];
    readonly instructions: string | null;
    readonly reason: string;
    readonly lines: readonly {
      readonly itemId: string;
      readonly itemName: string;
      readonly description: string | null;
      readonly quantity: string;
      readonly unitPrice: string;
      readonly taxCodeId: string | null;
    }[];
  }[];
  readonly visits: readonly VisitSummary[];
  readonly canManage: boolean;
}

export async function getServiceAgreement(
  actor: ServiceActor & { agreementId: string },
): Promise<ServiceAgreementDetail> {
  return withOrgTransaction(actor.orgId, async () => {
    await lockServiceFeature(actor.orgId);
    const agreement = (
      await db.execute<ServiceAgreementDetail["agreement"]>(
        sql`select x.id, x.revision, x.agreement_number as "agreementNumber", x.title, x.status,
        x.starts_on::text as "startsOn", x.ends_on::text as "endsOn", (select j.id from service_jobs j where j.org_id = x.org_id and j.agreement_id = x.id) as "jobId",
        (select job_number from service_jobs j where j.org_id = x.org_id and j.agreement_id = x.id) as "jobNumber",
        x.generated_through::text as "generatedThrough", x.subsidiary_id as "subsidiaryId", x.customer_party_id as "customerPartyId", x.close_reason as "closeReason",
        ${PARTY_COLUMNS(sql`x.customer_party_id`, sql`x.service_address_id`, sql`x.contact_id`, sql`x.subsidiary_id`)}
      from service_agreements x where x.org_id = ${actor.orgId} and x.id = ${requireUuid(actor.agreementId, "Agreement")}`,
        "objects",
      )
    )[0];
    if (!agreement) throw new ScopeNotFoundError();
    await serviceAuthority(actor, "service.read", agreement.subsidiaryId);
    const versions = await db.execute<ServiceAgreementDetail["versions"][number]>(
      sql`select ver.id, ver.effective_from::text as "effectiveFrom", ver.recurrence,
        to_char(ver.window_starts, 'HH24:MI') as "windowStarts", to_char(ver.window_ends, 'HH24:MI') as "windowEnds", ver.estimated_minutes as "estimatedMinutes",
        ver.priority, ver.required_qualification_type_ids::text[] as "requiredQualificationTypeIds", ver.instructions, ver.reason,
        coalesce((select jsonb_agg(jsonb_build_object('itemId', l.item_id, 'itemName', i.name, 'description', l.description, 'quantity', l.quantity::text,
            'unitPrice', l.unit_price::text, 'taxCodeId', l.tax_code_id) order by l.line_number)
          from service_agreement_lines l join items i on i.org_id = l.org_id and i.id = l.item_id where l.org_id = ver.org_id and l.version_id = ver.id), '[]'::jsonb) as lines
      from service_agreement_versions ver where ver.org_id = ${actor.orgId} and ver.agreement_id = ${agreement.id} order by ver.effective_from`,
      "objects",
    );
    const visits = await visitSummaries(
      actor.orgId,
      sql`v.agreement_id = ${agreement.id} and (v.status <> 'cancelled' or v.cancel_kind = 'skipped')`,
    );
    return {
      agreement,
      versions,
      visits,
      canManage: await holdsServicePermission(actor, "service.manage"),
    };
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(error);
  });
}

export interface ServiceHomeSummary {
  readonly openRequests: number;
  readonly unscheduledVisits: number;
  readonly todayVisits: number;
  readonly inProgressVisits: number;
  readonly responseBreaches: number;
  readonly awaitingReview: number;
  readonly readyToInvoice: number;
  readonly quotesAwaitingAnswer: number;
  readonly activeAgreements: number;
  readonly policyConfigured: boolean;
  readonly hasDispatchBoard: boolean;
}

/** The counts the service home shows, within the caller's legal entities. */
export async function serviceHomeSummary(actor: ServiceActor): Promise<ServiceHomeSummary> {
  return withOrgTransaction(actor.orgId, async () => {
    const allowed = await serviceAuthority(actor, "service.read", null);
    const scope = (column: ReturnType<typeof sql>) =>
      allowed === null
        ? sql``
        : allowed.size
          ? sql` and ${column} = any(${`{${[...allowed].join(",")}}`}::uuid[])`
          : sql` and false`;
    const today = await businessTodayInTx(db, actor.orgId);
    const row = (
      await db.execute<Omit<ServiceHomeSummary, "policyConfigured" | "hasDispatchBoard">>(
        sql`select
        (select count(*)::int from service_requests x where x.org_id = ${actor.orgId} and x.status in ('new','assessment_scheduled','assessed','quoted') ${scope(sql`x.subsidiary_id`)}) as "openRequests",
        (select count(*)::int from service_visits x left join service_jobs j on j.org_id = x.org_id and j.id = x.job_id
          where x.org_id = ${actor.orgId} and x.status = 'unscheduled' and (x.job_id is null or j.status = 'open') ${scope(sql`x.subsidiary_id`)}) as "unscheduledVisits",
        (select count(distinct x.id)::int from service_visits x join schedule_entries e on e.org_id = x.org_id and e.service_visit_id = x.id and e.status = 'published'
          where x.org_id = ${actor.orgId} and e.starts_on = ${today} ${scope(sql`x.subsidiary_id`)}) as "todayVisits",
        (select count(*)::int from service_visits x where x.org_id = ${actor.orgId} and x.status in ('en_route','on_site') ${scope(sql`x.subsidiary_id`)}) as "inProgressVisits",
        (select count(*)::int from service_visits x where x.org_id = ${actor.orgId} and x.sla_due_at < now() and x.status in ('unscheduled','scheduled','dispatched','en_route') ${scope(sql`x.subsidiary_id`)}) as "responseBreaches",
        (select count(*)::int from service_visits x where x.org_id = ${actor.orgId} and x.review_status = 'pending' ${scope(sql`x.subsidiary_id`)}) as "awaitingReview",
        ((select count(*)::int from service_visits x join service_jobs j on j.org_id = x.org_id and j.id = x.job_id
            where x.org_id = ${actor.orgId} and j.billing_mode = 'per_visit' and x.status = 'completed' and coalesce(x.review_status, 'not_required') in ('not_required','approved')
              and not exists (select 1 from service_billings b where b.org_id = x.org_id and b.visit_id = x.id and b.released_at is null) ${scope(sql`x.subsidiary_id`)})
         + (select count(*)::int from service_jobs j where j.org_id = ${actor.orgId} and j.billing_mode = 'per_job' and j.status = 'completed'
            and not exists (select 1 from service_billings b where b.org_id = j.org_id and b.job_id = j.id and b.visit_id is null and b.released_at is null) ${scope(sql`j.subsidiary_id`)})) as "readyToInvoice",
        (select count(*)::int from service_quotes q join documents d on d.org_id = q.org_id and d.id = q.quote_document_id
          where q.org_id = ${actor.orgId} and q.status = 'sent' ${scope(sql`d.subsidiary_id`)}) as "quotesAwaitingAnswer",
        (select count(*)::int from service_agreements x where x.org_id = ${actor.orgId} and x.status = 'active' ${scope(sql`x.subsidiary_id`)}) as "activeAgreements"`,
        "objects",
      )
    )[0]!;
    const policyConfigured = Boolean(
      (
        await db.execute(
          sql`select 1 from service_dispatch_policies where org_id = ${actor.orgId} and effective_from <= ${today} limit 1`,
          "objects",
        )
      )[0],
    );
    const hasDispatchBoard = Boolean(
      (
        await db.execute(
          sql`select 1 from schedule_boards where org_id = ${actor.orgId} and board_type = 'dispatch' and is_active limit 1`,
          "objects",
        )
      )[0],
    );
    return { ...row, policyConfigured, hasDispatchBoard };
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(error);
  });
}

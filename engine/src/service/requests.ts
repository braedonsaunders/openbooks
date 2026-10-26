/**
 * Service requests: work a customer asks for. Staff take requests directly;
 * customers submit them through the customer portal. A request may get an
 * assessment visit and a quote before it converts to a job, or is declined
 * or cancelled with a reason.
 */
import { sql, type SQL } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import {
  actorRef,
  allocateServiceNumber,
  auditService,
  lockCommandKey,
  lockServiceFeature,
  optionalDate,
  optionalText,
  requireExpectedRevision,
  requireOne,
  requirePriority,
  requiredText,
  requireUuid,
  resolveServiceCustomer,
  serviceAuthority,
  type ServiceActor,
} from "./common.ts";
import { ServiceError, serviceDatabaseRefusal, stale } from "./errors.ts";
import {
  requestIsOpen,
  requestTransitionAllowed,
  type RequestStatus,
  type ServicePriority,
} from "./status.ts";
import {
  cancelVisitInTransaction,
  insertVisit,
  lockVisit,
  normalizeVisitInput,
  type VisitInput,
} from "./visits.ts";

export type StoredRequest = {
  readonly id: string;
  readonly revision: number;
  readonly subsidiaryId: string;
  readonly requestNumber: string;
  readonly customerPartyId: string;
  readonly serviceAddressId: string | null;
  readonly contactId: string | null;
  readonly title: string;
  readonly description: string | null;
  readonly priority: ServicePriority;
  readonly preferredOn: string | null;
  readonly preferredTime: "any" | "morning" | "afternoon" | "evening";
  readonly source: "staff" | "portal";
  readonly status: RequestStatus;
  readonly jobId: string | null;
  readonly createdAt: string;
  readonly createdBy: string | null;
};

/** Request columns over a table reference (the table name, or an alias). */
export function requestColumns(t: SQL): SQL {
  return sql`${t}.id, ${t}.revision, ${t}.subsidiary_id as "subsidiaryId", ${t}.request_number as "requestNumber", ${t}.customer_party_id as "customerPartyId",
  ${t}.service_address_id as "serviceAddressId", ${t}.contact_id as "contactId", ${t}.title, ${t}.description, ${t}.priority, ${t}.preferred_on::text as "preferredOn",
  ${t}.preferred_time as "preferredTime", ${t}.source, ${t}.status,
  (select j.id from service_jobs j where j.org_id = ${t}.org_id and j.request_id = ${t}.id) as "jobId",
  to_char(${t}.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt", ${t}.created_by as "createdBy"`;
}

export const REQUEST_COLUMNS = requestColumns(sql`service_requests`);

export async function lockRequest(orgId: string, requestId: unknown): Promise<StoredRequest> {
  const row = (
    await db.execute<StoredRequest>(
      sql`select ${REQUEST_COLUMNS} from service_requests
    where org_id = ${orgId} and id = ${requireUuid(requestId, "Request")} for update`,
      "objects",
    )
  )[0];
  if (!row) throw new ScopeNotFoundError();
  return row;
}

export function checkRequestRevision(row: StoredRequest, expected: unknown): void {
  if (row.revision !== requireExpectedRevision(expected)) throw stale("This request");
}

export interface ServiceRequestInput {
  readonly customerPartyId: string;
  readonly serviceAddressId?: string | null;
  readonly contactId?: string | null;
  readonly subsidiaryId?: string | null;
  readonly title: string;
  readonly description?: string | null;
  readonly priority: ServicePriority;
  readonly preferredOn?: string | null;
  readonly preferredTime?: "any" | "morning" | "afternoon" | "evening";
}

function preferredTime(value: unknown): "any" | "morning" | "afternoon" | "evening" {
  if (value === undefined || value === null || value === "") return "any";
  if (value === "any" || value === "morning" || value === "afternoon" || value === "evening")
    return value;
  throw new ServiceError("Choose any time, morning, afternoon or evening.", {
    code: "service_invalid",
  });
}

function normalizeRequest(input: ServiceRequestInput) {
  return {
    title: requiredText(input.title, "Title", 200),
    description: optionalText(input.description, "Description", 8000),
    priority: requirePriority(input.priority),
    preferredOn: optionalDate(input.preferredOn, "Preferred date"),
    preferredTime: preferredTime(input.preferredTime),
  };
}

async function insertRequest(
  orgId: string,
  input: {
    id: string;
    customer: Awaited<ReturnType<typeof resolveServiceCustomer>>;
    fields: ReturnType<typeof normalizeRequest>;
    source: "staff" | "portal";
    actorId: string | null;
    portalLinkId: string | null;
  },
): Promise<StoredRequest> {
  const number = await allocateServiceNumber(orgId, "service_request");
  const row = requireOne(
    await db.execute<StoredRequest>(
      sql`insert into service_requests
      (id, org_id, subsidiary_id, request_number, customer_party_id, service_address_id, contact_id, title, description, priority, preferred_on, preferred_time,
       source, portal_link_id, status, created_by, updated_by)
    values (${input.id}, ${orgId}, ${input.customer.subsidiaryId}, ${number}, ${input.customer.customerPartyId}, ${input.customer.serviceAddressId}, ${input.customer.contactId},
      ${input.fields.title}, ${input.fields.description}, ${input.fields.priority}, ${input.fields.preferredOn}, ${input.fields.preferredTime},
      ${input.source}, ${input.portalLinkId}, 'new', ${input.actorId}, ${input.actorId})
    returning ${REQUEST_COLUMNS}`,
      "objects",
    ),
    "The service request",
  );
  await auditService({
    orgId,
    table: "service_requests",
    rowId: row.id,
    action: "insert",
    actorId: input.actorId,
    after: row,
    reason: input.source === "portal" ? "Submitted through the customer portal" : null,
  });
  return row;
}

/** Take a service request for a customer. The key makes a retried submission return the same request. */
export async function createServiceRequest(
  actor: ServiceActor & { id: string; input: ServiceRequestInput },
): Promise<StoredRequest> {
  const id = requireUuid(actor.id, "Request key");
  const fields = normalizeRequest(actor.input);
  return withOrgTransaction(actor.orgId, async () => {
    const allowed = await serviceAuthority(actor, "service.manage", null);
    await lockCommandKey("service-request", actor.orgId, id);
    const existing = (
      await db.execute<StoredRequest>(
        sql`select ${REQUEST_COLUMNS} from service_requests where org_id = ${actor.orgId} and id = ${id}`,
        "objects",
      )
    )[0];
    if (existing) {
      if (
        existing.createdBy !== actor.actorId ||
        existing.title !== fields.title ||
        existing.customerPartyId !== actor.input.customerPartyId
      ) {
        throw new ServiceError("This request key was already used for a different request.", {
          status: 409,
          code: "service_key_reused",
          remedy: "Reload; the existing request is preserved.",
        });
      }
      return existing;
    }
    const customer = await resolveServiceCustomer(actor.orgId, allowed, actor.input);
    return insertRequest(actor.orgId, {
      id,
      customer,
      fields,
      source: "staff",
      actorId: actor.actorId,
      portalLinkId: null,
    });
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(error);
  });
}

/**
 * A request a customer submits through the portal. The portal session names
 * the customer; the address and contact must be the customer's own.
 */
export async function createPortalServiceRequest(input: {
  orgId: string;
  partyId: string;
  linkId: string;
  id: string;
  request: Omit<ServiceRequestInput, "customerPartyId" | "subsidiaryId" | "priority"> & {
    urgent?: boolean;
  };
}): Promise<StoredRequest> {
  const id = requireUuid(input.id, "Request key");
  const fields = normalizeRequest({
    ...input.request,
    customerPartyId: input.partyId,
    priority: input.request.urgent ? "high" : "normal",
  });
  return withOrgTransaction(input.orgId, async () => {
    await lockServiceFeature(input.orgId);
    await lockCommandKey("service-request", input.orgId, id);
    const existing = (
      await db.execute<StoredRequest>(
        sql`select ${REQUEST_COLUMNS} from service_requests where org_id = ${input.orgId} and id = ${id}`,
        "objects",
      )
    )[0];
    if (existing) {
      if (
        existing.customerPartyId !== input.partyId ||
        existing.source !== "portal" ||
        existing.title !== fields.title
      ) {
        throw new ServiceError("This request was already submitted with different details.", {
          status: 409,
          code: "service_key_reused",
          remedy: "Reload the page to see your requests.",
        });
      }
      return existing;
    }
    const customer = await resolveServiceCustomer(input.orgId, null, {
      customerPartyId: input.partyId,
      serviceAddressId: input.request.serviceAddressId,
      contactId: input.request.contactId,
    });
    return insertRequest(input.orgId, {
      id,
      customer,
      fields,
      source: "portal",
      actorId: null,
      portalLinkId: requireUuid(input.linkId, "Portal session"),
    });
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(error);
  });
}

/** Change an open request's details. */
export async function updateServiceRequest(
  actor: ServiceActor & { requestId: string; expectedRevision: number; input: ServiceRequestInput },
): Promise<StoredRequest> {
  const fields = normalizeRequest(actor.input);
  return withOrgTransaction(actor.orgId, async () => {
    const request = await lockRequest(actor.orgId, actor.requestId);
    checkRequestRevision(request, actor.expectedRevision);
    const allowed = await serviceAuthority(actor, "service.manage", request.subsidiaryId);
    if (!requestIsOpen(request.status))
      throw new ServiceError("A closed request keeps its details.", {
        status: 409,
        code: "service_invalid_transition",
        remedy: "Open the job created from it, or take a new request.",
      });
    if (actor.input.customerPartyId !== request.customerPartyId)
      throw new ServiceError("A request keeps its customer.", {
        code: "service_invalid",
        remedy: "Cancel it and take a new request for the other customer.",
      });
    const customer = await resolveServiceCustomer(actor.orgId, allowed, {
      ...actor.input,
      subsidiaryId: request.subsidiaryId,
    });
    const row = requireOne(
      await db.execute<StoredRequest>(
        sql`update service_requests set service_address_id = ${customer.serviceAddressId}, contact_id = ${customer.contactId},
        title = ${fields.title}, description = ${fields.description}, priority = ${fields.priority}, preferred_on = ${fields.preferredOn}, preferred_time = ${fields.preferredTime},
        revision = revision + 1, updated_at = now(), updated_by = ${actor.actorId}
      where org_id = ${actor.orgId} and id = ${request.id} and revision = ${request.revision} returning ${REQUEST_COLUMNS}`,
        "objects",
      ),
      "The request",
    );
    await auditService({
      orgId: actor.orgId,
      table: "service_requests",
      rowId: request.id,
      action: "update",
      actorId: actor.actorId,
      before: request,
      after: row,
    });
    return row;
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(error);
  });
}

/** Move a request's status in the caller's transaction. */
export async function setRequestStatus(
  actor: ServiceActor,
  request: StoredRequest,
  to: RequestStatus,
  extra: { reason?: string | null } = {},
): Promise<StoredRequest> {
  if (request.status === to) return request;
  if (!requestTransitionAllowed(request.status, to)) {
    throw new ServiceError(
      `A ${request.status.replace(/_/g, " ")} request cannot become ${to.replace(/_/g, " ")}.`,
      { status: 409, code: "service_invalid_transition", remedy: "Reload the request." },
    );
  }
  const row = requireOne(
    await db.execute<StoredRequest>(
      sql`update service_requests set status = ${to},
      close_reason = ${to === "declined" || to === "cancelled" ? (extra.reason ?? null) : null},
      revision = revision + 1, updated_at = now(), updated_by = ${actorRef(actor)}
    where org_id = ${actor.orgId} and id = ${request.id} and revision = ${request.revision} returning ${REQUEST_COLUMNS}`,
      "objects",
    ),
    "The request",
  );
  await auditService({
    orgId: actor.orgId,
    table: "service_requests",
    rowId: request.id,
    action: "update",
    actorId: actorRef(actor),
    before: { status: request.status },
    after: { status: to },
    reason: extra.reason ?? null,
  });
  return row;
}

/** Decline or cancel a request. Its open assessment visits are cancelled with it. */
export async function closeServiceRequest(
  actor: ServiceActor & {
    requestId: string;
    expectedRevision: number;
    outcome: "declined" | "cancelled";
    reason: string;
  },
): Promise<StoredRequest> {
  const reason = requiredText(actor.reason, "Reason", 2000);
  if (actor.outcome !== "declined" && actor.outcome !== "cancelled")
    throw new ServiceError("Choose declined or cancelled.", { code: "service_invalid" });
  return withOrgTransaction(actor.orgId, async () => {
    const request = await lockRequest(actor.orgId, actor.requestId);
    checkRequestRevision(request, actor.expectedRevision);
    await serviceAuthority(actor, "service.manage", request.subsidiaryId);
    const visits = await db.execute<{ id: string }>(
      sql`select id from service_visits where org_id = ${actor.orgId} and request_id = ${request.id}
      and status in ('unscheduled','scheduled','dispatched') order by sequence`,
      "objects",
    );
    const active = (
      await db.execute(
        sql`select 1 from service_visits where org_id = ${actor.orgId} and request_id = ${request.id} and status in ('en_route','on_site') limit 1`,
        "objects",
      )
    )[0];
    if (active)
      throw new ServiceError("An assessment is in progress.", {
        status: 409,
        code: "service_invalid_transition",
        remedy: "Wait for the assessment visit to finish.",
      });
    for (const { id } of visits)
      await cancelVisitInTransaction(actor, await lockVisit(actor.orgId, id), reason);
    return setRequestStatus(actor, request, actor.outcome, { reason });
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(error);
  });
}

/** Schedule an assessment: an unscheduled assessment visit on the request, ready for the dispatch queue. */
export async function addAssessmentVisit(
  actor: ServiceActor & { requestId: string; expectedRevision: number; visit: VisitInput },
): Promise<{ request: StoredRequest; visitId: string }> {
  return withOrgTransaction(actor.orgId, async () => {
    const request = await lockRequest(actor.orgId, actor.requestId);
    checkRequestRevision(request, actor.expectedRevision);
    await serviceAuthority(actor, "service.manage", request.subsidiaryId);
    if (!requestIsOpen(request.status))
      throw new ServiceError("A closed request takes no further visits.", {
        status: 409,
        code: "service_invalid_transition",
        remedy: "Open the job created from it.",
      });
    const visit = await normalizeVisitInput(
      actor.orgId,
      { ...actor.visit, preferredOn: actor.visit.preferredOn ?? request.preferredOn },
      { priority: request.priority, requiredQualificationTypeIds: [] },
    );
    const visitId = await insertVisit(actor, {
      subsidiaryId: request.subsidiaryId,
      kind: "assessment",
      jobId: null,
      requestId: request.id,
      slaDueAt: null,
      visit,
    });
    const next =
      request.status === "new"
        ? await setRequestStatus(actor, request, "assessment_scheduled")
        : request;
    return { request: next, visitId };
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(error);
  });
}

export type PortalServiceRequest = {
  readonly id: string;
  readonly requestNumber: string;
  readonly title: string;
  readonly status: RequestStatus;
  readonly preferredOn: string | null;
  readonly createdAt: string;
  /** The next booked visit's start, for the customer's own reference. */
  readonly nextVisitAt: string | null;
  readonly jobStatus: string | null;
};

/** The customer's own requests, newest first, as the portal shows them. */
export async function listPortalServiceRequests(
  orgId: string,
  partyId: string,
): Promise<PortalServiceRequest[]> {
  return withOrgTransaction(orgId, async () => {
    await lockServiceFeature(orgId);
    return await db.execute<PortalServiceRequest>(
      sql`select r.id, r.request_number as "requestNumber", r.title, r.status, r.preferred_on::text as "preferredOn",
        to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",
        (select to_char(min(e.starts_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') from service_visits v
           join schedule_entries e on e.org_id = v.org_id and e.service_visit_id = v.id and e.status = 'published'
          where v.org_id = r.org_id and (v.request_id = r.id or v.job_id = j.id) and v.status in ('scheduled','dispatched','en_route') and e.ends_at > now()) as "nextVisitAt",
        j.status as "jobStatus"
      from service_requests r left join service_jobs j on j.org_id = r.org_id and j.request_id = r.id
      where r.org_id = ${orgId} and r.customer_party_id = ${partyId}
      order by r.created_at desc, r.id limit 100`,
      "objects",
    );
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(error);
  });
}

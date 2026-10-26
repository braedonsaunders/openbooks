/**
 * Service jobs: the service location, site contact, priced scope lines,
 * priority, required qualifications, duration estimate and response target
 * for work done over one or more visits. A job comes from a request, an
 * accepted service quote, an agreement, or is taken directly.
 */
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import { orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import {
  allocateServiceNumber,
  auditService,
  lockCommandKey,
  optionalTaxCode,
  optionalText,
  optionalUuid,
  requireActiveItem,
  requireExpectedRevision,
  requireMinutes,
  requireMoney,
  requireOne,
  requirePriority,
  requireQualificationTypes,
  requireQuantity,
  requiredText,
  requireUnitPrice,
  requireUuid,
  resolveServiceCustomer,
  serviceAuthority,
  type ServiceActor,
} from "./common.ts";
import { ServiceError, serviceDatabaseRefusal, stale } from "./errors.ts";
import { policyOn } from "./policy.ts";
import { lockRequest, setRequestStatus } from "./requests.ts";
import {
  requestIsOpen,
  responseHours,
  visitIsFinished,
  type JobStatus,
  type ServicePriority,
  type VisitStatus,
} from "./status.ts";
import {
  cancelVisitInTransaction,
  insertVisit,
  lockVisit,
  normalizeVisitInput,
  type VisitInput,
} from "./visits.ts";
import { releaseVoidedBillings } from "./billing-release.ts";

export type BillingMode = "per_job" | "per_visit" | "not_billable";

export type StoredJob = {
  readonly id: string;
  readonly revision: number;
  readonly subsidiaryId: string;
  readonly jobNumber: string;
  readonly customerPartyId: string;
  readonly serviceAddressId: string | null;
  readonly contactId: string | null;
  readonly requestId: string | null;
  readonly quoteDocumentId: string | null;
  readonly agreementId: string | null;
  readonly title: string;
  readonly description: string | null;
  readonly priority: ServicePriority;
  readonly requiredQualificationTypeIds: string[];
  readonly estimatedMinutes: number;
  readonly slaDueAt: string | null;
  readonly billingMode: BillingMode;
  readonly laborItemId: string | null;
  readonly laborUnitPrice: string | null;
  readonly currency: string;
  readonly depositRequired: string;
  readonly status: JobStatus;
  readonly createdAt: string;
};

export const JOB_COLUMNS = sql`id, revision, subsidiary_id as "subsidiaryId", job_number as "jobNumber", customer_party_id as "customerPartyId",
  service_address_id as "serviceAddressId", contact_id as "contactId", request_id as "requestId", quote_document_id as "quoteDocumentId",
  agreement_id as "agreementId", title, description, priority, required_qualification_type_ids::text[] as "requiredQualificationTypeIds",
  estimated_minutes as "estimatedMinutes", to_char(sla_due_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "slaDueAt",
  billing_mode as "billingMode", labor_item_id as "laborItemId", labor_unit_price::text as "laborUnitPrice", currency,
  deposit_required::text as "depositRequired", status, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt"`;

export async function lockJob(orgId: string, jobId: unknown): Promise<StoredJob> {
  const row = (
    await db.execute<StoredJob>(
      sql`select ${JOB_COLUMNS} from service_jobs where org_id = ${orgId} and id = ${requireUuid(jobId, "Job")} for update`,
      "objects",
    )
  )[0];
  if (!row) throw new ScopeNotFoundError();
  return row;
}

export function checkJobRevision(job: StoredJob, expected: unknown): void {
  if (job.revision !== requireExpectedRevision(expected)) throw stale("This job");
}

export interface JobLineInput {
  readonly itemId: string;
  readonly description?: string | null;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly taxCodeId?: string | null;
  readonly sourceQuoteLineId?: string | null;
}

export interface ServiceJobInput {
  readonly requestId?: string | null;
  readonly customerPartyId?: string;
  readonly serviceAddressId?: string | null;
  readonly contactId?: string | null;
  readonly subsidiaryId?: string | null;
  readonly title?: string;
  readonly description?: string | null;
  readonly priority?: ServicePriority;
  readonly requiredQualificationTypeIds?: readonly string[];
  readonly estimatedMinutes: number;
  readonly billingMode: BillingMode;
  readonly laborItemId?: string | null;
  readonly laborUnitPrice?: string | null;
  readonly depositRequired?: string | null;
  readonly lines?: readonly JobLineInput[];
  /** The first visit, unscheduled; omitted only when visits are added later (or by an agreement). */
  readonly firstVisit?: Omit<
    VisitInput,
    "estimatedMinutes" | "requiredQualificationTypeIds" | "priority"
  > | null;
}

export async function normalizeLines(
  orgId: string,
  lines: readonly JobLineInput[] | undefined,
): Promise<
  {
    itemId: string;
    description: string | null;
    quantity: string;
    unitPrice: string;
    taxCodeId: string | null;
    sourceQuoteLineId: string | null;
  }[]
> {
  if (!lines) return [];
  if (!Array.isArray(lines) || lines.length > 500)
    throw new ServiceError("A job holds at most 500 lines.", { code: "service_invalid" });
  const out = [];
  for (const [index, line] of lines.entries()) {
    const item = await requireActiveItem(orgId, line.itemId, `Line ${index + 1} item`);
    out.push({
      itemId: item.id,
      description: optionalText(line.description, `Line ${index + 1} description`, 2000),
      quantity: requireQuantity(line.quantity, `Line ${index + 1} quantity`),
      unitPrice: requireUnitPrice(line.unitPrice, `Line ${index + 1} unit price`),
      taxCodeId: await optionalTaxCode(orgId, line.taxCodeId),
      sourceQuoteLineId: optionalUuid(line.sourceQuoteLineId, `Line ${index + 1} quote line`),
    });
  }
  return out;
}

export async function writeJobLines(
  actor: ServiceActor,
  jobId: string,
  lines: Awaited<ReturnType<typeof normalizeLines>>,
): Promise<void> {
  await db.execute(
    sql`delete from service_job_lines where org_id = ${actor.orgId} and job_id = ${jobId}`,
  );
  for (const [index, line] of lines.entries()) {
    requireOne(
      await db.execute(
        sql`insert into service_job_lines (org_id, job_id, line_number, item_id, description, quantity, unit_price, tax_code_id, source_quote_line_id, created_by)
      values (${actor.orgId}, ${jobId}, ${index + 1}, ${line.itemId}, ${line.description}, ${line.quantity}, ${line.unitPrice}, ${line.taxCodeId}, ${line.sourceQuoteLineId}, ${actor.actorId})
      returning id`,
        "objects",
      ),
      "A job line",
    );
  }
}

/** The currency a job bills in: the customer's currency when Multi-currency is on, else the legal entity's. */
export async function jobCurrency(
  orgId: string,
  subsidiaryId: string,
  customerPartyId: string,
): Promise<string> {
  const base = (
    await db.execute<{ currency: string }>(
      sql`select base_currency as currency from subsidiaries where org_id = ${orgId} and id = ${subsidiaryId}`,
      "objects",
    )
  )[0]?.currency;
  if (!base)
    throw new ServiceError("The legal entity has no base currency.", {
      code: "service_configuration_missing",
      remedy: "Set the legal entity's base currency in Company Settings.",
    });
  if (!(await orgFeatureEnabled(orgId, "multiCurrency"))) return base;
  const customer = (
    await db.execute<{ currency: string | null }>(
      sql`select currency from customer_roles where org_id = ${orgId} and party_id = ${customerPartyId}`,
      "objects",
    )
  )[0]?.currency;
  return customer?.trim() ? customer.trim().toUpperCase() : base;
}

/** The response target from the policy in force when the work was asked for. */
export async function responseDueAt(
  orgId: string,
  priority: ServicePriority,
  askedAt: string,
): Promise<string | null> {
  const policy = await policyOn(orgId, askedAt.slice(0, 10));
  if (!policy) return null;
  const hours = responseHours(policy, priority);
  return hours === null ? null : new Date(Date.parse(askedAt) + hours * 3_600_000).toISOString();
}

export async function validateLabor(
  orgId: string,
  input: ServiceJobInput,
): Promise<{ laborItemId: string | null; laborUnitPrice: string | null }> {
  const laborItemId = optionalUuid(input.laborItemId, "Labor item");
  if (!laborItemId) {
    if (
      input.laborUnitPrice !== undefined &&
      input.laborUnitPrice !== null &&
      input.laborUnitPrice !== ""
    )
      throw new ServiceError("A labor rate needs its labor item.", {
        code: "service_invalid",
        remedy: "Choose the item that bills labor, or clear the rate.",
      });
    return { laborItemId: null, laborUnitPrice: null };
  }
  await requireActiveItem(orgId, laborItemId, "Labor item");
  return { laborItemId, laborUnitPrice: requireUnitPrice(input.laborUnitPrice, "Labor rate") };
}

export function billingMode(value: unknown): BillingMode {
  if (value === "per_job" || value === "per_visit" || value === "not_billable") return value;
  throw new ServiceError("Choose how the job is invoiced: per job, per visit, or not billable.", {
    code: "service_invalid",
  });
}

/**
 * Create a job in the caller's transaction. Used by the direct command, by
 * quote acceptance and by agreements.
 */
export async function insertJob(
  actor: ServiceActor,
  input: {
    id: string;
    customer: Awaited<ReturnType<typeof resolveServiceCustomer>>;
    requestId: string | null;
    quoteDocumentId: string | null;
    agreementId: string | null;
    title: string;
    description: string | null;
    priority: ServicePriority;
    requiredQualificationTypeIds: string[];
    estimatedMinutes: number;
    billingMode: BillingMode;
    laborItemId: string | null;
    laborUnitPrice: string | null;
    depositRequired: string;
    askedAt: string;
    lines: Awaited<ReturnType<typeof normalizeLines>>;
  },
): Promise<StoredJob> {
  const number = await allocateServiceNumber(actor.orgId, "service_job");
  const currency = await jobCurrency(
    actor.orgId,
    input.customer.subsidiaryId,
    input.customer.customerPartyId,
  );
  const slaDueAt = await responseDueAt(actor.orgId, input.priority, input.askedAt);
  const job = requireOne(
    await db.execute<StoredJob>(
      sql`insert into service_jobs
      (id, org_id, subsidiary_id, job_number, customer_party_id, service_address_id, contact_id, request_id, quote_document_id, agreement_id, title, description,
       priority, required_qualification_type_ids, estimated_minutes, sla_due_at, billing_mode, labor_item_id, labor_unit_price, currency, deposit_required,
       status, created_by, updated_by)
    values (${input.id}, ${actor.orgId}, ${input.customer.subsidiaryId}, ${number}, ${input.customer.customerPartyId}, ${input.customer.serviceAddressId}, ${input.customer.contactId},
      ${input.requestId}, ${input.quoteDocumentId}, ${input.agreementId}, ${input.title}, ${input.description}, ${input.priority},
      ${`{${input.requiredQualificationTypeIds.join(",")}}`}::uuid[], ${input.estimatedMinutes}, ${slaDueAt}, ${input.billingMode}, ${input.laborItemId}, ${input.laborUnitPrice},
      ${currency}, ${input.depositRequired}, 'open', ${actor.actorId}, ${actor.actorId})
    returning ${JOB_COLUMNS}`,
      "objects",
    ),
    "The service job",
  );
  await writeJobLines(actor, job.id, input.lines);
  await auditService({
    orgId: actor.orgId,
    table: "service_jobs",
    rowId: job.id,
    action: "insert",
    actorId: actor.actorId,
    after: { ...job, lines: input.lines },
  });
  return job;
}

/** Take a job directly or convert a request to one. Converting a request closes it as converted. */
export async function createServiceJob(
  actor: ServiceActor & { id: string; input: ServiceJobInput },
): Promise<{ job: StoredJob; visitId: string | null }> {
  const id = requireUuid(actor.id, "Job key");
  const input = actor.input;
  return withOrgTransaction(actor.orgId, async () => {
    const allowed = await serviceAuthority(actor, "service.manage", null);
    await lockCommandKey("service-job", actor.orgId, id);
    const existing = (
      await db.execute<StoredJob & { createdBy: string }>(
        sql`select ${JOB_COLUMNS}, created_by as "createdBy" from service_jobs where org_id = ${actor.orgId} and id = ${id}`,
        "objects",
      )
    )[0];
    if (existing) {
      if (existing.createdBy !== actor.actorId)
        throw new ServiceError("This job key was already used.", {
          status: 409,
          code: "service_key_reused",
          remedy: "Reload; the existing job is preserved.",
        });
      const firstVisit = (
        await db.execute<{ id: string }>(
          sql`select id from service_visits where org_id = ${actor.orgId} and job_id = ${id} order by sequence limit 1`,
          "objects",
        )
      )[0];
      return { job: existing, visitId: firstVisit?.id ?? null };
    }
    const request = input.requestId ? await lockRequest(actor.orgId, input.requestId) : null;
    if (request) {
      if (!requestIsOpen(request.status))
        throw new ServiceError("This request is already closed.", {
          status: 409,
          code: "service_invalid_transition",
          remedy: "Open the job created from it.",
        });
      const active = (
        await db.execute(
          sql`select 1 from service_visits where org_id = ${actor.orgId} and request_id = ${request.id} and status in ('scheduled','dispatched','en_route','on_site') limit 1`,
          "objects",
        )
      )[0];
      if (active)
        throw new ServiceError("The request's assessment visit is still booked or in progress.", {
          status: 409,
          code: "service_invalid_transition",
          remedy: "Complete or cancel the assessment visit before converting the request.",
        });
    }
    const customer = await resolveServiceCustomer(
      actor.orgId,
      allowed,
      request
        ? {
            customerPartyId: request.customerPartyId,
            serviceAddressId: input.serviceAddressId ?? request.serviceAddressId,
            contactId: input.contactId ?? request.contactId,
            subsidiaryId: request.subsidiaryId,
          }
        : {
            customerPartyId: input.customerPartyId,
            serviceAddressId: input.serviceAddressId,
            contactId: input.contactId,
            subsidiaryId: input.subsidiaryId,
          },
    );
    const priority =
      input.priority === undefined
        ? (request?.priority ?? "normal")
        : requirePriority(input.priority);
    const required = await requireQualificationTypes(
      actor.orgId,
      input.requiredQualificationTypeIds ?? [],
    );
    const labor = await validateLabor(actor.orgId, input);
    const job = await insertJob(actor, {
      id,
      customer,
      requestId: request?.id ?? null,
      quoteDocumentId: null,
      agreementId: null,
      title: requiredText(input.title ?? request?.title, "Title", 200),
      description: optionalText(
        input.description === undefined ? request?.description : input.description,
        "Description",
        8000,
      ),
      priority,
      requiredQualificationTypeIds: required,
      estimatedMinutes: requireMinutes(input.estimatedMinutes, "Duration estimate"),
      billingMode: billingMode(input.billingMode),
      ...labor,
      depositRequired:
        input.depositRequired === undefined ||
        input.depositRequired === null ||
        input.depositRequired === ""
          ? "0"
          : requireMoney(input.depositRequired, "Deposit"),
      askedAt: request?.createdAt ?? new Date().toISOString(),
      lines: await normalizeLines(actor.orgId, input.lines),
    });
    if (request) await setRequestStatus(actor, request, "converted");
    let visitId: string | null = null;
    if (input.firstVisit !== null) {
      const visit = await normalizeVisitInput(
        actor.orgId,
        {
          ...(input.firstVisit ?? {}),
          estimatedMinutes: job.estimatedMinutes,
          preferredOn: input.firstVisit?.preferredOn ?? request?.preferredOn ?? null,
        },
        { priority: job.priority, requiredQualificationTypeIds: job.requiredQualificationTypeIds },
      );
      visitId = await insertVisit(actor, {
        subsidiaryId: job.subsidiaryId,
        kind: "service",
        jobId: job.id,
        requestId: null,
        slaDueAt: job.slaDueAt,
        visit,
      });
    }
    return { job, visitId };
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(error);
  });
}

/** Change an open job's header. Customer and request stay; scope lines change through replaceJobLines. */
export async function updateServiceJob(
  actor: ServiceActor & {
    jobId: string;
    expectedRevision: number;
    input: Omit<
      ServiceJobInput,
      "requestId" | "customerPartyId" | "subsidiaryId" | "lines" | "firstVisit"
    >;
  },
): Promise<StoredJob> {
  const input = actor.input;
  return withOrgTransaction(actor.orgId, async () => {
    const job = await lockJob(actor.orgId, actor.jobId);
    checkJobRevision(job, actor.expectedRevision);
    const allowed = await serviceAuthority(actor, "service.manage", job.subsidiaryId);
    if (job.status !== "open")
      throw new ServiceError("Only an open job changes.", {
        status: 409,
        code: "service_invalid_transition",
        remedy: "Reopen the job first.",
      });
    await releaseVoidedBillings(actor, job.id);
    const customer = await resolveServiceCustomer(actor.orgId, allowed, {
      customerPartyId: job.customerPartyId,
      serviceAddressId: input.serviceAddressId,
      contactId: input.contactId,
      subsidiaryId: job.subsidiaryId,
    });
    const labor = await validateLabor(actor.orgId, input);
    const mode = billingMode(input.billingMode);
    if (job.agreementId && mode === "per_job")
      throw new ServiceError("Agreement jobs are invoiced per visit.", { code: "service_invalid" });
    const billed = (
      await db.execute(
        sql`select 1 from service_billings where org_id = ${actor.orgId} and job_id = ${job.id} and released_at is null limit 1`,
        "objects",
      )
    )[0];
    if (
      billed &&
      (mode !== job.billingMode ||
        labor.laborItemId !== job.laborItemId ||
        labor.laborUnitPrice !== job.laborUnitPrice)
    ) {
      throw new ServiceError("An invoiced job keeps its billing terms.", {
        status: 409,
        code: "service_invalid",
        remedy: "Void the job's invoices before changing how it bills.",
      });
    }
    const priority = input.priority === undefined ? job.priority : requirePriority(input.priority);
    const required =
      input.requiredQualificationTypeIds === undefined
        ? job.requiredQualificationTypeIds
        : await requireQualificationTypes(actor.orgId, input.requiredQualificationTypeIds);
    const row = requireOne(
      await db.execute<StoredJob>(
        sql`update service_jobs set service_address_id = ${customer.serviceAddressId}, contact_id = ${customer.contactId},
        title = ${requiredText(input.title ?? job.title, "Title", 200)}, description = ${optionalText(input.description === undefined ? job.description : input.description, "Description", 8000)},
        priority = ${priority}, required_qualification_type_ids = ${`{${required.join(",")}}`}::uuid[], estimated_minutes = ${requireMinutes(input.estimatedMinutes, "Duration estimate")},
        billing_mode = ${mode}, labor_item_id = ${labor.laborItemId}, labor_unit_price = ${labor.laborUnitPrice},
        deposit_required = ${input.depositRequired === undefined || input.depositRequired === null || input.depositRequired === "" ? job.depositRequired : requireMoney(input.depositRequired, "Deposit")},
        revision = revision + 1, updated_at = now(), updated_by = ${actor.actorId}
      where org_id = ${actor.orgId} and id = ${job.id} and revision = ${job.revision} returning ${JOB_COLUMNS}`,
        "objects",
      ),
      "The job",
    );
    await auditService({
      orgId: actor.orgId,
      table: "service_jobs",
      rowId: job.id,
      action: "update",
      actorId: actor.actorId,
      before: job,
      after: row,
    });
    return row;
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(error);
  });
}

/** Replace an open, uninvoiced job's scope lines. */
export async function replaceJobLines(
  actor: ServiceActor & { jobId: string; expectedRevision: number; lines: readonly JobLineInput[] },
): Promise<StoredJob> {
  return withOrgTransaction(actor.orgId, async () => {
    const job = await lockJob(actor.orgId, actor.jobId);
    checkJobRevision(job, actor.expectedRevision);
    await serviceAuthority(actor, "service.manage", job.subsidiaryId);
    if (job.status !== "open")
      throw new ServiceError("Only an open job's lines change.", {
        status: 409,
        code: "service_invalid_transition",
        remedy: "Reopen the job first.",
      });
    await releaseVoidedBillings(actor, job.id);
    const before = await db.execute(
      sql`select line_number, item_id, description, quantity::text, unit_price::text, tax_code_id from service_job_lines
      where org_id = ${actor.orgId} and job_id = ${job.id} order by line_number`,
      "objects",
    );
    const lines = await normalizeLines(actor.orgId, actor.lines);
    await writeJobLines(actor, job.id, lines);
    const row = requireOne(
      await db.execute<StoredJob>(
        sql`update service_jobs set revision = revision + 1, updated_at = now(), updated_by = ${actor.actorId}
      where org_id = ${actor.orgId} and id = ${job.id} and revision = ${job.revision} returning ${JOB_COLUMNS}`,
        "objects",
      ),
      "The job",
    );
    await auditService({
      orgId: actor.orgId,
      table: "service_job_lines",
      rowId: job.id,
      action: "update",
      actorId: actor.actorId,
      before,
      after: lines,
      reason: "Job scope changed",
    });
    return row;
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(error);
  });
}

/** Add a visit to an open job: a return visit, a follow-up, or a further day of work. */
export async function addJobVisit(
  actor: ServiceActor & { jobId: string; expectedRevision: number; visit: VisitInput },
): Promise<{ job: StoredJob; visitId: string }> {
  return withOrgTransaction(actor.orgId, async () => {
    const job = await lockJob(actor.orgId, actor.jobId);
    checkJobRevision(job, actor.expectedRevision);
    await serviceAuthority(actor, "service.manage", job.subsidiaryId);
    if (job.status !== "open")
      throw new ServiceError("Visits are added to open jobs.", {
        status: 409,
        code: "service_invalid_transition",
        remedy: "Reopen the job first.",
      });
    const visit = await normalizeVisitInput(actor.orgId, actor.visit, {
      priority: job.priority,
      requiredQualificationTypeIds: job.requiredQualificationTypeIds,
    });
    const visitId = await insertVisit(actor, {
      subsidiaryId: job.subsidiaryId,
      kind: "service",
      jobId: job.id,
      requestId: null,
      slaDueAt: null,
      visit,
    });
    const row = requireOne(
      await db.execute<StoredJob>(
        sql`update service_jobs set revision = revision + 1, updated_at = now(), updated_by = ${actor.actorId}
      where org_id = ${actor.orgId} and id = ${job.id} and revision = ${job.revision} returning ${JOB_COLUMNS}`,
        "objects",
      ),
      "The job",
    );
    await auditService({
      orgId: actor.orgId,
      table: "service_visits",
      rowId: visitId,
      action: "insert",
      actorId: actor.actorId,
      after: { jobId: job.id, ...visit },
    });
    return { job: row, visitId };
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(error);
  });
}

/** Mark a job complete once no visit is booked or in progress. */
export async function completeServiceJob(
  actor: ServiceActor & { jobId: string; expectedRevision: number },
): Promise<StoredJob> {
  return withOrgTransaction(actor.orgId, async () => {
    const job = await lockJob(actor.orgId, actor.jobId);
    checkJobRevision(job, actor.expectedRevision);
    await serviceAuthority(actor, "service.manage", job.subsidiaryId);
    if (job.status !== "open")
      throw new ServiceError("Only an open job is completed.", {
        status: 409,
        code: "service_invalid_transition",
        remedy: "Reload the job.",
      });
    if (job.agreementId) {
      const agreement = (
        await db.execute<{ status: string }>(
          sql`select status from service_agreements where org_id = ${actor.orgId} and id = ${job.agreementId}`,
          "objects",
        )
      )[0];
      if (agreement?.status === "active")
        throw new ServiceError("An agreement job stays open while its agreement is active.", {
          status: 409,
          code: "service_invalid_transition",
          remedy: "End the agreement first.",
        });
    }
    const visits = await db.execute<{ id: string; status: VisitStatus }>(
      sql`select id, status from service_visits where org_id = ${actor.orgId} and job_id = ${job.id}`,
      "objects",
    );
    if (!visits.some((visit) => visit.status === "completed"))
      throw new ServiceError("No visit on this job was completed.", {
        status: 409,
        code: "service_invalid_transition",
        remedy: "Complete a visit, or cancel the job instead.",
      });
    for (const visit of visits) {
      if (visit.status === "unscheduled")
        await cancelVisitInTransaction(
          actor,
          await lockVisit(actor.orgId, visit.id),
          "The job was completed",
        );
      else if (!visitIsFinished(visit.status))
        throw new ServiceError("The job still has visits booked or in progress.", {
          status: 409,
          code: "service_invalid_transition",
          remedy: "Complete, reschedule or cancel them first.",
        });
    }
    const row = requireOne(
      await db.execute<StoredJob>(
        sql`update service_jobs set status = 'completed', completed_at = now(), completed_by = ${actor.actorId},
        revision = revision + 1, updated_at = now(), updated_by = ${actor.actorId}
      where org_id = ${actor.orgId} and id = ${job.id} and revision = ${job.revision} returning ${JOB_COLUMNS}`,
        "objects",
      ),
      "The job",
    );
    await auditService({
      orgId: actor.orgId,
      table: "service_jobs",
      rowId: job.id,
      action: "update",
      actorId: actor.actorId,
      before: { status: job.status },
      after: { status: "completed" },
    });
    return row;
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(error);
  });
}

/** Reopen a completed job that is not yet invoiced as a whole. */
export async function reopenServiceJob(
  actor: ServiceActor & { jobId: string; expectedRevision: number; reason: string },
): Promise<StoredJob> {
  const reason = requiredText(actor.reason, "Reason", 2000);
  return withOrgTransaction(actor.orgId, async () => {
    const job = await lockJob(actor.orgId, actor.jobId);
    checkJobRevision(job, actor.expectedRevision);
    await serviceAuthority(actor, "service.manage", job.subsidiaryId);
    if (job.status !== "completed")
      throw new ServiceError("Only a completed job is reopened.", {
        status: 409,
        code: "service_invalid_transition",
        remedy: "Reload the job.",
      });
    await releaseVoidedBillings(actor, job.id);
    const row = requireOne(
      await db.execute<StoredJob>(
        sql`update service_jobs set status = 'open', completed_at = null, completed_by = null,
        revision = revision + 1, updated_at = now(), updated_by = ${actor.actorId}
      where org_id = ${actor.orgId} and id = ${job.id} and revision = ${job.revision} returning ${JOB_COLUMNS}`,
        "objects",
      ),
      "The job",
    );
    await auditService({
      orgId: actor.orgId,
      table: "service_jobs",
      rowId: job.id,
      action: "update",
      actorId: actor.actorId,
      before: { status: "completed" },
      after: { status: "open" },
      reason,
    });
    return row;
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(error);
  });
}

/** Cancel a job that has no booked or worked visits; its unscheduled visits are cancelled with it. */
export async function cancelServiceJob(
  actor: ServiceActor & { jobId: string; expectedRevision: number; reason: string },
): Promise<StoredJob> {
  const reason = requiredText(actor.reason, "Reason", 2000);
  return withOrgTransaction(actor.orgId, async () => {
    const job = await lockJob(actor.orgId, actor.jobId);
    checkJobRevision(job, actor.expectedRevision);
    await serviceAuthority(actor, "service.manage", job.subsidiaryId);
    if (job.status !== "open")
      throw new ServiceError("Only an open job is cancelled.", {
        status: 409,
        code: "service_invalid_transition",
        remedy: "Reload the job.",
      });
    if (job.agreementId)
      throw new ServiceError("An agreement's job ends with the agreement.", {
        code: "service_invalid",
        remedy: "Cancel the agreement instead.",
      });
    const visits = await db.execute<{ id: string; status: VisitStatus }>(
      sql`select id, status from service_visits where org_id = ${actor.orgId} and job_id = ${job.id}`,
      "objects",
    );
    for (const visit of visits) {
      if (visit.status === "cancelled") continue;
      if (
        visit.status !== "unscheduled" &&
        visit.status !== "scheduled" &&
        visit.status !== "dispatched"
      ) {
        throw new ServiceError("A job with worked visits is completed, not cancelled.", {
          status: 409,
          code: "service_invalid_transition",
          remedy: "Complete the job instead.",
        });
      }
      await cancelVisitInTransaction(actor, await lockVisit(actor.orgId, visit.id), reason);
    }
    const row = requireOne(
      await db.execute<StoredJob>(
        sql`update service_jobs set status = 'cancelled', close_reason = ${reason},
        revision = revision + 1, updated_at = now(), updated_by = ${actor.actorId}
      where org_id = ${actor.orgId} and id = ${job.id} and revision = ${job.revision} returning ${JOB_COLUMNS}`,
        "objects",
      ),
      "The job",
    );
    await auditService({
      orgId: actor.orgId,
      table: "service_jobs",
      rowId: job.id,
      action: "update",
      actorId: actor.actorId,
      before: { status: job.status },
      after: { status: "cancelled" },
      reason,
    });
    return row;
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(error);
  });
}

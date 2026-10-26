/**
 * Invoicing service work through native customer invoices. A per-visit job
 * bills each completed visit once: the job's scope (or the agreement
 * version's per-visit lines), the visit's billable parts and its approved
 * labor. A per-job job bills once when it is complete: its scope plus every
 * visit's billable parts and approved labor.
 *
 * The invoice is created through the native document writer (validation,
 * numbering, tax and idempotency), and the billing link is recorded in the
 * same transaction; posting runs through the native document lifecycle.
 * A billing link releases only when its invoice is voided, so work is never
 * invoiced twice. Deposits are native customer payments held on account and
 * applied to the job's posted invoices through native credit settlement.
 */
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { businessToday } from "../platform/business-date.ts";
import { add, cmp, mulDecimalFactors, neg, sum } from "../money/money.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import { orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import { createDocument } from "../ledger/document-write.ts";
import { resolveDocumentLineDefaults } from "../ledger/document-defaults.ts";
import type { DocumentLineInput } from "../ledger/document-input.ts";
import { applyStandaloneCredits } from "../payments/credit-settlement.ts";
import { creditItemsForParty, openItemsForParty } from "../payments/payment-queries.ts";
import {
  auditService,
  lockServiceFeature,
  requireOne,
  requireUuid,
  serviceAuthority,
  type ServiceActor,
} from "./common.ts";
import { ServiceError, serviceDatabaseRefusal } from "./errors.ts";
import { lockJob, type StoredJob } from "./jobs.ts";
import { lockVisit } from "./visits.ts";
import { releaseVoidedBillings } from "./billing-release.ts";

/** quantity × unit price, exact, rounded once to the ledger's four places. */
export function lineAmount(quantity: string, unitPrice: string): string {
  return mulDecimalFactors("1", [quantity, unitPrice]);
}

const KEY_NAMESPACE = Buffer.from("5f0b9c5a8e2d4c7b9a1e6d3f2c4b8a17", "hex");

/** A stable document key for one billing of one job or visit; a released billing starts a new attempt. */
export function serviceInvoiceKey(orgId: string, target: string, attempt: number): string {
  const digest = createHash("sha1")
    .update(KEY_NAMESPACE)
    .update(orgId, "utf8")
    .update(`service-invoice:${target}:${attempt}`, "utf8")
    .digest();
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

interface PlannedLine {
  readonly itemId: string;
  /** Billed with the item named on the invoice; stock parts already issued at completion bill on the item's income account. */
  readonly invoiceItem: boolean;
  readonly description: string;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly taxCodeId: string | null;
  readonly timeEntryIds: readonly string[];
}

export interface ServiceInvoicePlan {
  readonly jobId: string;
  readonly visitId: string | null;
  readonly lines: readonly (PlannedLine & { amount: string })[];
  readonly total: string;
  readonly currency: string;
}

async function attemptNumber(
  orgId: string,
  jobId: string,
  visitId: string | null,
): Promise<number> {
  const released = (
    await db.execute<{ count: number }>(
      sql`select count(*)::int as count from service_billings
    where org_id = ${orgId} and job_id = ${jobId} and ${visitId ? sql`visit_id = ${visitId}` : sql`visit_id is null`} and released_at is not null`,
      "objects",
    )
  )[0]!.count;
  return released + 1;
}

async function itemName(orgId: string, itemId: string): Promise<string> {
  return (
    (
      await db.execute<{ name: string }>(
        sql`select coalesce(nullif(code, '') || ' — ', '') || name as name from items where org_id = ${orgId} and id = ${itemId}`,
        "objects",
      )
    )[0]?.name ?? "Item"
  );
}

async function scopeLines(
  orgId: string,
  job: StoredJob,
  visit: { agreementVersionId: string | null } | null,
): Promise<PlannedLine[]> {
  const rows = visit?.agreementVersionId
    ? await db.execute<{
        itemId: string;
        description: string | null;
        quantity: string;
        unitPrice: string;
        taxCodeId: string | null;
      }>(
        sql`select item_id as "itemId", description,
        quantity::text, unit_price::text as "unitPrice", tax_code_id as "taxCodeId" from service_agreement_lines
        where org_id = ${orgId} and version_id = ${visit.agreementVersionId} order by line_number`,
        "objects",
      )
    : await db.execute<{
        itemId: string;
        description: string | null;
        quantity: string;
        unitPrice: string;
        taxCodeId: string | null;
      }>(
        sql`select item_id as "itemId", description,
        quantity::text, unit_price::text as "unitPrice", tax_code_id as "taxCodeId" from service_job_lines
        where org_id = ${orgId} and job_id = ${job.id} order by line_number`,
        "objects",
      );
  const out: PlannedLine[] = [];
  for (const row of rows) {
    out.push({
      itemId: row.itemId,
      invoiceItem: true,
      description: row.description ?? (await itemName(orgId, row.itemId)),
      quantity: row.quantity,
      unitPrice: row.unitPrice,
      taxCodeId: row.taxCodeId,
      timeEntryIds: [],
    });
  }
  return out;
}

async function partLines(orgId: string, visitIds: readonly string[]): Promise<PlannedLine[]> {
  if (!visitIds.length) return [];
  const rows = await db.execute<{
    itemId: string;
    name: string;
    quantity: string;
    unitPrice: string;
    profiled: boolean;
    memo: string | null;
  }>(
    sql`
    select sp.item_id as "itemId", coalesce(nullif(i.code, '') || ' — ', '') || i.name as name, sp.quantity::text, sp.unit_price::text as "unitPrice", sp.memo,
           exists (select 1 from item_inventory_profiles p where p.org_id = sp.org_id and p.item_id = sp.item_id) as profiled
      from service_visit_parts sp join items i on i.org_id = sp.org_id and i.id = sp.item_id
     where sp.org_id = ${orgId} and sp.visit_id = any(${`{${visitIds.join(",")}}`}::uuid[]) and sp.billable
     order by sp.created_at, sp.id`,
    "objects",
  );
  return rows.map((row) => ({
    itemId: row.itemId,
    invoiceItem: !row.profiled,
    description: row.memo ? `${row.name} — ${row.memo}` : row.name,
    quantity: row.quantity,
    unitPrice: row.unitPrice,
    taxCodeId: null,
    timeEntryIds: [],
  }));
}

/** Approved, unbilled labor on the visits, one line per technician; unapproved labor refuses. */
async function laborLines(
  orgId: string,
  job: StoredJob,
  visitIds: readonly string[],
): Promise<PlannedLine[]> {
  if (!job.laborItemId || !job.laborUnitPrice || !visitIds.length) return [];
  const entries = await db.execute<{
    id: string;
    status: string;
    hours: string;
    billingStatus: string;
    isBillable: boolean;
    worker: string;
    workerName: string;
  }>(
    sql`
    select te.id, te.status, te.hours::text, te.billing_status as "billingStatus", te.is_billable as "isBillable", te.employee_party_id as worker, p.display_name as "workerName"
      from time_entries te join parties p on p.org_id = te.org_id and p.id = te.employee_party_id
     where te.org_id = ${orgId} and te.service_visit_id = any(${`{${visitIds.join(",")}}`}::uuid[]) and te.status <> 'rejected'
     order by p.display_name, te.worked_on, te.id for update of te`,
    "objects",
  );
  const unapproved = entries.filter(
    (entry) =>
      entry.isBillable && entry.billingStatus === "unbilled" && entry.status !== "approved",
  );
  if (unapproved.length) {
    throw new ServiceError(
      `${unapproved.length} labor ${unapproved.length === 1 ? "entry is" : "entries are"} not yet approved.`,
      {
        code: "service_labor_unapproved",
        remedy: "Approve the technicians' time in Timesheets, then invoice the work.",
      },
    );
  }
  const byWorker = new Map<string, { name: string; hours: string[]; ids: string[] }>();
  for (const entry of entries) {
    if (!entry.isBillable || entry.billingStatus !== "unbilled") continue;
    const group = byWorker.get(entry.worker) ?? { name: entry.workerName, hours: [], ids: [] };
    group.hours.push(entry.hours);
    group.ids.push(entry.id);
    byWorker.set(entry.worker, group);
  }
  const labor = await itemName(orgId, job.laborItemId);
  return [...byWorker.values()].map((group) => ({
    itemId: job.laborItemId!,
    invoiceItem: true,
    description: `${labor} — ${group.name}`,
    quantity: sum(group.hours),
    unitPrice: job.laborUnitPrice!,
    taxCodeId: null,
    timeEntryIds: group.ids,
  }));
}

/** Lock and check a job or visit for invoicing, and plan its invoice lines. */
async function planInvoice(
  actor: ServiceActor,
  job: StoredJob,
  visitId: string | null,
): Promise<{ visitIds: string[]; lines: PlannedLine[]; label: string }> {
  if (job.billingMode === "not_billable")
    throw new ServiceError("This job is not billable.", {
      code: "service_invalid",
      remedy: "Change the job's billing to per job or per visit first.",
    });
  await releaseVoidedBillings(actor, job.id);
  if (visitId) {
    if (job.billingMode !== "per_visit")
      throw new ServiceError("This job is invoiced as a whole.", {
        code: "service_invalid",
        remedy: "Invoice the job once it is complete.",
      });
    const visit = await lockVisit(actor.orgId, visitId);
    if (visit.jobId !== job.id) throw new ScopeNotFoundError();
    if (visit.status !== "completed")
      throw new ServiceError("Only a completed visit is invoiced.", {
        status: 409,
        code: "service_invalid_transition",
        remedy: "Complete the visit first.",
      });
    if (visit.reviewStatus === "pending")
      throw new ServiceError("The visit's completion is awaiting review.", {
        status: 409,
        code: "service_review_pending",
        remedy: "Decide the review in Approvals first.",
      });
    const billed = (
      await db.execute(
        sql`select 1 from service_billings where org_id = ${actor.orgId} and visit_id = ${visit.id} and released_at is null`,
        "objects",
      )
    )[0];
    if (billed)
      throw new ServiceError("This visit is already invoiced.", {
        status: 409,
        code: "service_already_billed",
        remedy: "Open its invoice; void it to invoice the visit again.",
      });
    const lines = [
      ...(await scopeLines(actor.orgId, job, visit)),
      ...(await partLines(actor.orgId, [visit.id])),
      ...(await laborLines(actor.orgId, job, [visit.id])),
    ];
    return { visitIds: [visit.id], lines, label: `visit ${visit.sequence}` };
  }
  if (job.billingMode !== "per_job")
    throw new ServiceError("This job is invoiced per visit.", {
      code: "service_invalid",
      remedy: "Invoice each completed visit.",
    });
  if (job.status !== "completed")
    throw new ServiceError("A job invoiced as a whole is invoiced once it is complete.", {
      status: 409,
      code: "service_invalid_transition",
      remedy: "Complete the job first.",
    });
  const billed = (
    await db.execute(
      sql`select 1 from service_billings where org_id = ${actor.orgId} and job_id = ${job.id} and visit_id is null and released_at is null`,
      "objects",
    )
  )[0];
  if (billed)
    throw new ServiceError("This job is already invoiced.", {
      status: 409,
      code: "service_already_billed",
      remedy: "Open its invoice; void it to invoice the job again.",
    });
  const pending = (
    await db.execute(
      sql`select 1 from service_visits where org_id = ${actor.orgId} and job_id = ${job.id} and review_status = 'pending' limit 1`,
      "objects",
    )
  )[0];
  if (pending)
    throw new ServiceError("A visit's completion is awaiting review.", {
      status: 409,
      code: "service_review_pending",
      remedy: "Decide the review in Approvals first.",
    });
  const visitIds = (
    await db.execute<{ id: string }>(
      sql`select id from service_visits where org_id = ${actor.orgId} and job_id = ${job.id} and status = 'completed' order by sequence`,
      "objects",
    )
  ).map((row) => row.id);
  const lines = [
    ...(await scopeLines(actor.orgId, job, null)),
    ...(await partLines(actor.orgId, visitIds)),
    ...(await laborLines(actor.orgId, job, visitIds)),
  ];
  return { visitIds, lines, label: "job" };
}

/** What an invoice for the job or visit would bill, without writing. */
export async function previewServiceInvoice(
  actor: ServiceActor & { jobId: string; visitId?: string | null },
): Promise<ServiceInvoicePlan> {
  return withOrgTransaction(actor.orgId, async () => {
    const job = await lockJob(actor.orgId, actor.jobId);
    await serviceAuthority(actor, "service.read", job.subsidiaryId);
    const plan = await planInvoice(
      actor,
      job,
      actor.visitId ? requireUuid(actor.visitId, "Visit") : null,
    );
    const lines = plan.lines.map((line) => ({
      ...line,
      amount: lineAmount(line.quantity, line.unitPrice),
    }));
    return {
      jobId: job.id,
      visitId: actor.visitId ?? null,
      lines,
      total: sum(lines.map((line) => line.amount)),
      currency: job.currency,
    };
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(error);
  });
}

export interface ServiceInvoiceResult {
  readonly invoiceId: string;
  readonly documentNumber: string;
  readonly replayed: boolean;
}

/**
 * Create the native draft invoice for a completed visit (per-visit jobs) or
 * a completed job (per-job jobs), and record the billing link. Invoicing
 * needs service management and receivables entry in the job's legal entity.
 */
export async function invoiceServiceWork(
  actor: ServiceActor & { jobId: string; visitId?: string | null },
): Promise<ServiceInvoiceResult> {
  return withOrgTransaction(actor.orgId, async () => {
    const job = await lockJob(actor.orgId, actor.jobId);
    await serviceAuthority(actor, "service.manage", job.subsidiaryId);
    await lockActorCommandAuthority(db, actor.orgId, actor.actorId, job.subsidiaryId, "ar.create");
    const visitId = actor.visitId ? requireUuid(actor.visitId, "Visit") : null;
    await releaseVoidedBillings(actor, job.id);
    const attempt = await attemptNumber(actor.orgId, job.id, visitId);
    const key = serviceInvoiceKey(
      actor.orgId,
      visitId ? `visit:${visitId}` : `job:${job.id}`,
      attempt,
    );
    const existing = (
      await db.execute<{ id: string; documentNumber: string }>(
        sql`select d.id, d.document_number as "documentNumber" from service_billings b
      join documents d on d.org_id = b.org_id and d.id = b.invoice_document_id
      where b.org_id = ${actor.orgId} and b.invoice_document_id = ${key} and b.released_at is null and d.status <> 'voided'`,
        "objects",
      )
    )[0];
    if (existing)
      return { invoiceId: existing.id, documentNumber: existing.documentNumber, replayed: true };
    const plan = await planInvoice(actor, job, visitId);
    if (!plan.lines.length)
      throw new ServiceError("There is nothing to invoice.", {
        code: "service_nothing_to_bill",
        remedy: "Add scope lines to the job or billable parts and labor to its visits.",
      });
    const defaults = new Map(
      (
        await resolveDocumentLineDefaults(db, actor.orgId, {
          kind: "customer_invoice",
          partyId: job.customerPartyId,
          itemIds: plan.lines.map((line) => line.itemId),
        })
      ).map((entry) => [entry.itemId, entry]),
    );
    const lines: DocumentLineInput[] = [];
    for (const line of plan.lines) {
      const fallback = defaults.get(line.itemId);
      if (!fallback?.accountId) {
        throw new ServiceError(
          `${await itemName(actor.orgId, line.itemId)} has no income account for invoicing.`,
          {
            code: "service_configuration_missing",
            remedy: "Set the item's income account on the item record, then invoice again.",
          },
        );
      }
      const amount = lineAmount(line.quantity, line.unitPrice);
      lines.push({
        accountId: fallback.accountId,
        itemId: line.invoiceItem ? line.itemId : null,
        description: line.description,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        amount,
        taxCodeId: line.taxCodeId ?? fallback.taxCodeId ?? null,
      });
    }
    const today = await businessToday(actor.orgId);
    const header = (
      await db.execute<{ jobNumber: string }>(
        sql`select job_number as "jobNumber" from service_jobs where org_id = ${actor.orgId} and id = ${job.id}`,
        "objects",
      )
    )[0]!;
    const multiCurrency = await orgFeatureEnabled(actor.orgId, "multiCurrency");
    const body = {
      partyId: job.customerPartyId,
      documentDate: today,
      subsidiaryId: job.subsidiaryId,
      memo: `Service ${header.jobNumber} — ${job.title}${plan.label === "job" ? "" : ` (${plan.label})`}`,
      ...(multiCurrency ? { currency: job.currency } : {}),
      custom: { serviceJob: { jobId: job.id, visitId, jobNumber: header.jobNumber } },
      lines,
    };
    const created = await createDocument({
      orgId: actor.orgId,
      userId: actor.actorId,
      kind: "customer_invoice",
      key,
      body,
      subsidiaryId: job.subsidiaryId,
      requestBody: { serviceInvoice: { jobId: job.id, visitId, attempt } },
    });
    requireOne(
      await db.execute(
        sql`insert into service_billings (org_id, job_id, visit_id, invoice_document_id, created_by)
      values (${actor.orgId}, ${job.id}, ${visitId}, ${created.id}, ${actor.actorId}) returning id`,
        "objects",
      ),
      "The billing link",
    );
    const invoiceLines = await db.execute<{ id: string; lineNumber: number }>(
      sql`select id, line_number as "lineNumber" from document_lines
      where org_id = ${actor.orgId} and document_id = ${created.id} order by line_number`,
      "objects",
    );
    for (const [index, line] of plan.lines.entries()) {
      if (!line.timeEntryIds.length) continue;
      const invoiceLine = invoiceLines[index];
      if (!invoiceLine)
        throw new ServiceError("The invoice lines do not match the planned labor.", {
          code: "service_not_saved",
          remedy: "Try again; nothing was saved.",
        });
      const marked = await db.execute(
        sql`update time_entries set billing_status = 'billed', invoiced_by_line_id = ${invoiceLine.id}, updated_at = now(), updated_by = ${actor.actorId}
        where org_id = ${actor.orgId} and id = any(${`{${line.timeEntryIds.join(",")}}`}::uuid[]) and billing_status = 'unbilled' and status = 'approved' returning id`,
        "objects",
      );
      if (marked.length !== line.timeEntryIds.length)
        throw new ServiceError("Labor changed while the invoice was being created.", {
          status: 409,
          code: "service_stale",
          remedy: "Reload the job and invoice again.",
        });
    }
    await auditService({
      orgId: actor.orgId,
      table: "service_billings",
      rowId: created.id,
      action: "insert",
      actorId: actor.actorId,
      after: {
        jobId: job.id,
        visitId,
        invoiceId: created.id,
        documentNumber: created.documentNumber,
        total: sum(lines.map((line) => line.amount)),
      },
    });
    return {
      invoiceId: created.id,
      documentNumber: created.documentNumber,
      replayed: created.status === "replayed",
    };
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(error);
  });
}

/** Link a posted customer payment held on account to a job as its deposit. */
export async function recordServiceDeposit(
  actor: ServiceActor & { jobId: string; paymentDocumentId: string },
): Promise<{ depositId: string; amount: string }> {
  return withOrgTransaction(actor.orgId, async () => {
    const job = await lockJob(actor.orgId, actor.jobId);
    await serviceAuthority(actor, "service.manage", job.subsidiaryId);
    const allowed = await lockActorCommandAuthority(
      db,
      actor.orgId,
      actor.actorId,
      job.subsidiaryId,
      "ar.read",
    );
    if (job.status === "cancelled")
      throw new ServiceError("A cancelled job takes no deposit.", {
        status: 409,
        code: "service_invalid_transition",
      });
    const paymentId = requireUuid(actor.paymentDocumentId, "Payment");
    const payment = (
      await db.execute<{
        kind: string;
        status: string;
        partyId: string | null;
        subsidiaryId: string | null;
      }>(
        sql`select kind, status, party_id as "partyId", subsidiary_id as "subsidiaryId"
      from documents where org_id = ${actor.orgId} and id = ${paymentId} for share`,
        "objects",
      )
    )[0];
    if (!payment || payment.kind !== "customer_payment") throw new ScopeNotFoundError();
    if (payment.status !== "posted")
      throw new ServiceError("The deposit payment must be posted.", {
        status: 409,
        code: "service_invalid",
        remedy: "Post the payment in Payments first.",
      });
    if (payment.partyId !== job.customerPartyId)
      throw new ServiceError("The payment is from another customer.", {
        code: "service_invalid",
        remedy: "Choose a payment received from the job's customer.",
      });
    if (payment.subsidiaryId && payment.subsidiaryId !== job.subsidiaryId)
      throw new ServiceError("The payment belongs to another legal entity.", {
        code: "service_invalid",
      });
    const unapplied = (
      await creditItemsForParty(job.customerPartyId, "ar", actor.orgId, allowed, {
        includeUnappliedPayments: true,
      })
    ).filter((item) => item.documentId === paymentId);
    const amount = sum(unapplied.map((item) => item.transactionOpen));
    if (cmp(amount, "0") <= 0)
      throw new ServiceError("The payment has no amount held on account.", {
        code: "service_invalid",
        remedy: "Receive the deposit as a payment with its amount left on account.",
      });
    const row = requireOne(
      await db.execute<{ id: string }>(
        sql`insert into service_job_deposits (org_id, job_id, payment_document_id, amount, created_by)
      values (${actor.orgId}, ${job.id}, ${paymentId}, ${amount}, ${actor.actorId}) returning id`,
        "objects",
      ),
      "The deposit",
    );
    await auditService({
      orgId: actor.orgId,
      table: "service_job_deposits",
      rowId: row.id,
      action: "insert",
      actorId: actor.actorId,
      after: { jobId: job.id, paymentId, amount },
    });
    return { depositId: row.id, amount };
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(error);
  });
}

/**
 * Apply the job's deposits still held on account to one of its posted
 * invoices, oldest deposit first, up to the invoice's open balance. Each
 * application is a native credit settlement.
 */
export async function applyServiceDeposits(
  actor: ServiceActor & { jobId: string; invoiceDocumentId: string },
): Promise<{ applied: string }> {
  await lockServiceFeature(actor.orgId);
  const prepared = await withOrgTransaction(actor.orgId, async () => {
    const job = await lockJob(actor.orgId, actor.jobId);
    await serviceAuthority(actor, "service.manage", job.subsidiaryId);
    const allowed = await lockActorCommandAuthority(
      db,
      actor.orgId,
      actor.actorId,
      job.subsidiaryId,
      "ar.create",
    );
    const invoiceId = requireUuid(actor.invoiceDocumentId, "Invoice");
    const linked = (
      await db.execute(
        sql`select 1 from service_billings where org_id = ${actor.orgId} and job_id = ${job.id} and invoice_document_id = ${invoiceId} and released_at is null`,
        "objects",
      )
    )[0];
    if (!linked)
      throw new ServiceError("The invoice is not one of this job's invoices.", {
        code: "service_invalid",
      });
    const deposits = (
      await db.execute<{ paymentId: string }>(
        sql`select payment_document_id as "paymentId" from service_job_deposits
      where org_id = ${actor.orgId} and job_id = ${job.id} order by created_at, id`,
        "objects",
      )
    ).map((row) => row.paymentId);
    if (!deposits.length) return null;
    const invoiceItems = (
      await openItemsForParty(job.customerPartyId, "ar", actor.orgId, allowed)
    ).filter((item) => item.documentId === invoiceId);
    if (!invoiceItems.length) {
      const status = (
        await db.execute<{ status: string }>(
          sql`select status from documents where org_id = ${actor.orgId} and id = ${invoiceId}`,
          "objects",
        )
      )[0]?.status;
      if (status !== "posted")
        throw new ServiceError("Deposits apply to a posted invoice.", {
          status: 409,
          code: "service_invalid",
          remedy: "Post the invoice first.",
        });
      return null;
    }
    const credits = (
      await creditItemsForParty(job.customerPartyId, "ar", actor.orgId, allowed, {
        includeUnappliedPayments: true,
      })
    )
      .filter((item) => item.documentId && deposits.includes(item.documentId))
      .sort((a, b) => deposits.indexOf(a.documentId!) - deposits.indexOf(b.documentId!));
    const allocations: {
      fromLineId: string;
      toLineId: string;
      amount: string;
      sourceDocumentId: string;
    }[] = [];
    const target = invoiceItems[0]!;
    let remaining = target.transactionOpen;
    for (const credit of credits) {
      if (cmp(remaining, "0") <= 0) break;
      if (credit.currency !== target.currency) continue;
      const amount =
        cmp(credit.transactionOpen, remaining) < 0 ? credit.transactionOpen : remaining;
      if (cmp(amount, "0") <= 0) continue;
      allocations.push({
        fromLineId: credit.lineId,
        toLineId: target.lineId,
        amount,
        sourceDocumentId: credit.documentId!,
      });
      remaining = add(remaining, neg(amount));
    }
    return allocations.length ? { job, allowed, allocations } : null;
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(error);
  });
  if (!prepared) return { applied: "0.0000" };
  const today = await businessToday(actor.orgId);
  const idempotencyKey = serviceInvoiceKey(
    actor.orgId,
    `deposit:${actor.invoiceDocumentId}:${prepared.allocations.map((a) => `${a.fromLineId}:${a.amount}`).join(",")}`,
    1,
  );
  const result = await applyStandaloneCredits(
    actor.orgId,
    actor.actorId,
    {
      partyId: prepared.job.customerPartyId,
      side: "ar",
      appliedOn: today,
      credits: prepared.allocations,
      idempotencyKey,
    },
    prepared.allowed,
  );
  await withOrgTransaction(actor.orgId, () =>
    auditService({
      orgId: actor.orgId,
      table: "service_job_deposits",
      rowId: prepared.job.id,
      action: "update",
      actorId: actor.actorId,
      after: {
        invoiceId: actor.invoiceDocumentId,
        applied: result.amount,
        applications: result.applicationIds,
      },
      reason: "Deposit applied to the job's invoice",
    }),
  );
  return { applied: result.amount };
}

export interface ServiceDepositCandidate {
  readonly paymentDocumentId: string;
  readonly documentNumber: string | null;
  readonly postingDate: string;
  readonly open: string;
  readonly currency: string;
}

/**
 * The job customer's posted payments that still hold an amount on account
 * and are not yet any job's deposit: what Record deposit may choose from.
 */
export async function serviceDepositCandidates(
  actor: ServiceActor & { jobId: string },
): Promise<ServiceDepositCandidate[]> {
  return withOrgTransaction(actor.orgId, async () => {
    const job = await lockJob(actor.orgId, actor.jobId);
    await serviceAuthority(actor, "service.manage", job.subsidiaryId);
    const allowed = await lockActorCommandAuthority(
      db,
      actor.orgId,
      actor.actorId,
      job.subsidiaryId,
      "ar.read",
    );
    const taken = new Set(
      (
        await db.execute<{ id: string }>(
          sql`select payment_document_id as id from service_job_deposits where org_id = ${actor.orgId}`,
          "objects",
        )
      ).map((row) => row.id),
    );
    const subsidiaries = new Map(
      (
        await db.execute<{ id: string; subsidiaryId: string | null }>(
          sql`select id, subsidiary_id as "subsidiaryId" from documents
      where org_id = ${actor.orgId} and party_id = ${job.customerPartyId} and kind = 'customer_payment' and status = 'posted'`,
          "objects",
        )
      ).map((row) => [row.id, row.subsidiaryId]),
    );
    const totals = new Map<string, ServiceDepositCandidate>();
    for (const item of await creditItemsForParty(job.customerPartyId, "ar", actor.orgId, allowed, {
      includeUnappliedPayments: true,
    })) {
      if (
        !item.documentId ||
        item.documentKind !== "customer_payment" ||
        taken.has(item.documentId) ||
        !subsidiaries.has(item.documentId)
      )
        continue;
      const subsidiaryId = subsidiaries.get(item.documentId);
      if (subsidiaryId && subsidiaryId !== job.subsidiaryId) continue;
      const prior = totals.get(item.documentId);
      totals.set(item.documentId, {
        paymentDocumentId: item.documentId,
        documentNumber: item.documentNumber,
        postingDate: item.postingDate,
        currency: item.currency,
        open: prior ? add(prior.open, item.transactionOpen) : add(item.transactionOpen, "0"),
      });
    }
    return [...totals.values()]
      .filter((candidate) => cmp(candidate.open, "0") > 0)
      .sort((a, b) => a.postingDate.localeCompare(b.postingDate));
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(error);
  });
}

import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { businessToday, isIsoCalendarDate } from "../platform/business-date.ts";
import { isUuid } from "../platform/uuid.ts";
import { canonicalDecimal, compareDecimal, divideDecimal, multiplyDecimal } from "../money/exact-decimal.ts";
import { normalizeMoney, sum, wholeDigits } from "../money/money.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import {
  resolveDraftSubsidiary,
  ScopeNotFoundError,
  subsidiaryScopeAllows,
} from "../organization/subsidiary-scope.ts";
import { documentRevisionCounterSql } from "../records/revision.ts";
import { captureTransactionAuditSnapshot, recordTransactionAudit } from "../records/transaction-audit.ts";
import { submitAndReleaseIfUngated } from "../flows/index.ts";
import { nextDocumentNumber } from "../ledger/document-totals.ts";
import { controlDeps } from "../ledger/document-service.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { runPostDocumentEffects } from "../ledger/posting-dispatch.ts";
import { requestDocumentVoid, type DocumentVoidResult } from "../ledger/document-void.ts";
import {
  assertInternalBillingLine,
  assertInternalBillingRuleAccounts,
  internalBillingAllowsBillable,
  internalBillingProvider,
  internalBillingReceiver,
  InternalBillingPolicyError,
} from "../ledger/internal-billing-policy.ts";
import { internalBillingRuleInEffect, loadInternalBillingAccount, type InternalBillingRuleRow } from "./rules.ts";
import {
  INTERNAL_BILLING_DISABLED,
  INTERNAL_BILLING_PROJECTS_DISABLED,
  InternalBillingError,
} from "./errors.ts";

/**
 * Internal billing documents. The writer here is the only path that sets
 * an internal billing document's lines: it resolves the rule version in
 * effect on the document date, snapshots that version's accounts onto every
 * line, and applies the same policy the posting rule re-checks. Posting and
 * voiding run the native document lifecycle (approval flows, posting kernel,
 * controlled void).
 */

const KIND = "internal_billing";
const NUMBER_PREFIX = "IB-";

export interface InternalBillingLineInput {
  itemId?: string | null;
  description?: string | null;
  /** Defaults to 1. */
  quantity?: string | null;
  /** Transfer price per unit; the amount is quantity × rate. */
  rate?: string | null;
  /** Transfer amount; used when no rate is given. */
  amount?: string | null;
  /** The receiver. An empty dimension is the provider's. */
  subsidiaryId?: string | null;
  departmentId?: string | null;
  projectId?: string | null;
  locationId?: string | null;
  classId?: string | null;
  /** Bill the receiving project's customer; defaults to the rule's setting. */
  isBillable?: boolean | null;
  /** Bill rate per unit; defaults to the transfer rate. */
  billRate?: string | null;
}

export interface InternalBillingDocumentInput {
  /** The rule code; the version in effect on the document date applies. */
  ruleCode: string;
  documentDate?: string | null;
  /** The provider. */
  subsidiaryId?: string | null;
  departmentId?: string | null;
  projectId?: string | null;
  locationId?: string | null;
  classId?: string | null;
  referenceNumber?: string | null;
  memo?: string | null;
  lines: InternalBillingLineInput[];
}

export interface InternalBillingSaved {
  id: string;
  documentNumber: string;
  status: string;
  revision: string;
}

function refusal(error: unknown): never {
  if (error instanceof InternalBillingPolicyError) throw new InternalBillingError(error.message);
  throw error;
}

function optionalId(value: unknown, label: string): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !isUuid(value)) throw new InternalBillingError(`${label} is not a valid reference`);
  return value;
}

function optionalText(value: unknown, label: string, max: number): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new InternalBillingError(`${label} must be text`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new InternalBillingError(`${label} must be at most ${max} characters`);
  return trimmed || null;
}

function positiveQuantity(value: unknown, lineNumber: number): string {
  if (value == null || value === "") return "1";
  const exact = canonicalDecimal(value, 8);
  if (exact === null || compareDecimal(exact, "0") <= 0 || wholeDigits(exact) > 15) {
    throw new InternalBillingError(`line ${lineNumber}: quantity must be a positive exact decimal`);
  }
  return exact;
}

function moneyOrNull(value: unknown, label: string, lineNumber: number): string | null {
  if (value == null || value === "") return null;
  const exact = canonicalDecimal(value, 4);
  if (exact === null || wholeDigits(exact) > 15) {
    throw new InternalBillingError(`line ${lineNumber}: ${label} must be an exact decimal with at most 4 places`);
  }
  return normalizeMoney(exact);
}

/** quantity × rate at ledger scale, exact. */
function extend(quantity: string, rate: string): string {
  return normalizeMoney(multiplyDecimal(quantity, rate, 4));
}

/** Existence (and activity) of a dimension in this organization. */
async function assertDimension(
  runner: SqlExecutor,
  orgId: string,
  table: "departments" | "locations" | "classes",
  id: string | null,
  label: string,
): Promise<void> {
  if (!id) return;
  const row = (await runner.execute<{ is_active: boolean }>(sql`
    select is_active from ${sql.raw(table)} where org_id = ${orgId} and id = ${id}`)).rows[0];
  if (!row) throw new InternalBillingError(`${label} was not found`);
  if (!row.is_active) throw new InternalBillingError(`${label} is inactive; choose an active one`);
}

async function assertProject(
  runner: SqlExecutor,
  orgId: string,
  projectId: string | null,
  subsidiaryId: string,
  label: string,
): Promise<void> {
  if (!projectId) return;
  const row = (await runner.execute<{ subsidiary_id: string | null; status: string }>(sql`
    select subsidiary_id, status from projects where org_id = ${orgId} and id = ${projectId}`)).rows[0];
  if (!row) throw new InternalBillingError(`${label} was not found`);
  if (row.subsidiary_id && row.subsidiary_id !== subsidiaryId) {
    throw new InternalBillingError(`${label} belongs to another subsidiary; choose that subsidiary or another project`);
  }
  if (row.status === "cancelled") throw new InternalBillingError(`${label} is cancelled`);
}

async function assertSubsidiary(runner: SqlExecutor, orgId: string, id: string, label: string): Promise<string> {
  const row = (await runner.execute<{ base_currency: string; is_active: boolean }>(sql`
    select base_currency, is_active from subsidiaries where org_id = ${orgId} and id = ${id}`)).rows[0];
  if (!row) throw new InternalBillingError(`${label} was not found`);
  if (!row.is_active) throw new InternalBillingError(`${label} is inactive`);
  return row.base_currency;
}

async function rootSubsidiaryId(runner: SqlExecutor, orgId: string): Promise<string> {
  const id = (await runner.execute<{ id: string }>(sql`
    select id from subsidiaries where org_id = ${orgId} and parent_id is null order by created_at limit 1`)).rows[0]?.id;
  if (!id) throw new InternalBillingError("the organization has no root subsidiary");
  return id;
}

async function requireFeatures(orgId: string, referencesProject: boolean): Promise<void> {
  if (!(await lockAndCheckOrgFeature(db, orgId, "internalBilling"))) {
    throw new InternalBillingError(INTERNAL_BILLING_DISABLED, 404);
  }
  if (referencesProject && !(await lockAndCheckOrgFeature(db, orgId, "projects"))) {
    throw new InternalBillingError(INTERNAL_BILLING_PROJECTS_DISABLED);
  }
}

interface PreparedLine {
  itemId: string | null;
  description: string | null;
  quantity: string;
  rate: string;
  amount: string;
  subsidiaryId: string | null;
  departmentId: string | null;
  projectId: string | null;
  locationId: string | null;
  classId: string | null;
  isBillable: boolean;
  billRate: string | null;
  billAmount: string | null;
}

/**
 * Create a draft, or replace an existing draft's header and lines. The rule
 * version in effect on the document date is resolved and stamped; every
 * line carries that version's accounts. `expectedRevision`, when given,
 * refuses a save over a version of the draft the caller never saw.
 */
export async function saveInternalBillingDraft(args: {
  orgId: string;
  actorId: string;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
  input: InternalBillingDocumentInput;
  /** Existing draft to replace; omitted to create one. */
  id?: string;
  expectedRevision?: string | null;
}): Promise<InternalBillingSaved> {
  const { orgId, input } = args;
  if (args.id !== undefined && !isUuid(args.id)) throw new InternalBillingError("not found", 404);
  const ruleCode = typeof input.ruleCode === "string" ? input.ruleCode.trim() : "";
  if (!ruleCode) throw new InternalBillingError("choose an internal billing rule");
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new InternalBillingError("add at least one line");
  }
  if (input.lines.length > 500) throw new InternalBillingError("a document holds at most 500 lines");
  const documentDate = input.documentDate ?? (await businessToday(orgId));
  if (!isIsoCalendarDate(documentDate)) throw new InternalBillingError("date must be a date (YYYY-MM-DD)");
  const header = {
    departmentId: optionalId(input.departmentId, "the providing department"),
    projectId: optionalId(input.projectId, "the providing project"),
    locationId: optionalId(input.locationId, "the providing location"),
    classId: optionalId(input.classId, "the providing class"),
  };
  const referenceNumber = optionalText(input.referenceNumber, "reference", 120);
  const memo = optionalText(input.memo, "memo", 2000);
  const referencesProject = header.projectId != null || input.lines.some((line) => line?.projectId);

  return withOrgTransaction(orgId, async () => {
    await requireFeatures(orgId, referencesProject);

    let existing: { id: string; documentNumber: string; status: string; subsidiaryId: string | null; revision: string } | null = null;
    if (args.id) {
      existing = (await db.execute<{ id: string; documentNumber: string; status: string; subsidiaryId: string | null; kind: string; revision: string }>(sql`
        select d.id, d.document_number as "documentNumber", d.status, d.subsidiary_id as "subsidiaryId", d.kind,
               ${documentRevisionCounterSql(sql.raw("d.revision_seq"))} as revision
          from documents d
         where d.org_id = ${orgId} and d.id = ${args.id}
         for update`)).rows.find((row) => row.kind === KIND) ?? null;
      if (!existing || !subsidiaryScopeAllows(args.allowedSubsidiaryIds, existing.subsidiaryId)) {
        throw new InternalBillingError("not found", 404);
      }
      if (existing.status !== "draft") {
        throw new InternalBillingError(`this document is ${existing.status}; only a draft can be edited — void it and enter a new one`);
      }
      if (args.expectedRevision != null && args.expectedRevision !== existing.revision) {
        throw new InternalBillingError("this document changed after you opened it; reload and review the latest version", 409);
      }
    }

    // The provider's legal entity.
    let providerSubsidiaryId: string;
    if (args.allowedSubsidiaryIds === null) {
      providerSubsidiaryId = optionalId(input.subsidiaryId, "the providing subsidiary") ?? existing?.subsidiaryId ?? (await rootSubsidiaryId(db, orgId));
    } else {
      const resolved = resolveDraftSubsidiary(args.allowedSubsidiaryIds, optionalId(input.subsidiaryId, "the providing subsidiary") ?? existing?.subsidiaryId ?? null);
      if (!resolved.ok || !resolved.subsidiaryId) {
        throw new InternalBillingError(
          resolved.ok || resolved.error === "subsidiary_required"
            ? "choose the providing subsidiary"
            : "the providing subsidiary is outside your access",
        );
      }
      providerSubsidiaryId = resolved.subsidiaryId;
    }
    const currency = await assertSubsidiary(db, orgId, providerSubsidiaryId, "the providing subsidiary");

    const rule: InternalBillingRuleRow | null = await internalBillingRuleInEffect(db, orgId, ruleCode, documentDate);
    if (!rule) {
      throw new InternalBillingError(
        `no version of internal billing rule ${ruleCode} is in effect on ${documentDate}; add one in Setup → Internal billing`,
      );
    }
    const debit = await loadInternalBillingAccount(db, orgId, rule.debitAccountId);
    const credit = await loadInternalBillingAccount(db, orgId, rule.creditAccountId);
    if (!debit || !credit) throw new InternalBillingError(`internal billing rule ${rule.code} names an account that does not exist`);
    try {
      assertInternalBillingRuleAccounts(rule.method, debit, credit);
    } catch (error) {
      refusal(error);
    }
    const multiSubsidiary = await lockAndCheckOrgFeature(db, orgId, "multiSubsidiary");

    await assertDimension(db, orgId, "departments", header.departmentId, "the providing department");
    await assertDimension(db, orgId, "locations", header.locationId, "the providing location");
    await assertDimension(db, orgId, "classes", header.classId, "the providing class");
    await assertProject(db, orgId, header.projectId, providerSubsidiaryId, "the providing project");
    const provider = internalBillingProvider(header, providerSubsidiaryId);

    const prepared: PreparedLine[] = [];
    for (const [index, raw] of input.lines.entries()) {
      const lineNumber = index + 1;
      if (!raw || typeof raw !== "object") throw new InternalBillingError(`line ${lineNumber} is malformed`);
      const quantity = positiveQuantity(raw.quantity, lineNumber);
      const enteredRate = moneyOrNull(raw.rate, "rate", lineNumber);
      const enteredAmount = moneyOrNull(raw.amount, "amount", lineNumber);
      if (enteredRate == null && enteredAmount == null) {
        throw new InternalBillingError(`line ${lineNumber}: enter a rate or an amount`);
      }
      const amount = enteredRate != null ? extend(quantity, enteredRate) : enteredAmount!;
      if (compareDecimal(amount, "0") <= 0) {
        throw new InternalBillingError(`line ${lineNumber}: the amount must be greater than zero`);
      }
      const rate = enteredRate ?? normalizeMoney(divideDecimal(amount, quantity, 4));
      const line = {
        subsidiaryId: optionalId(raw.subsidiaryId, `line ${lineNumber} subsidiary`),
        departmentId: optionalId(raw.departmentId, `line ${lineNumber} department`),
        projectId: optionalId(raw.projectId, `line ${lineNumber} project`),
        locationId: optionalId(raw.locationId, `line ${lineNumber} location`),
        classId: optionalId(raw.classId, `line ${lineNumber} class`),
      };
      // A line naming the provider's own subsidiary is the same entity.
      if (line.subsidiaryId === providerSubsidiaryId) line.subsidiaryId = null;
      const receiver = internalBillingReceiver(provider, line);
      if (line.subsidiaryId) {
        if (!subsidiaryScopeAllows(args.allowedSubsidiaryIds, line.subsidiaryId)) {
          throw new InternalBillingError(`line ${lineNumber}: the receiving subsidiary is outside your access`);
        }
        await assertSubsidiary(db, orgId, line.subsidiaryId, `line ${lineNumber} subsidiary`);
      }
      await assertDimension(db, orgId, "departments", line.departmentId, `line ${lineNumber} department`);
      await assertDimension(db, orgId, "locations", line.locationId, `line ${lineNumber} location`);
      await assertDimension(db, orgId, "classes", line.classId, `line ${lineNumber} class`);
      await assertProject(db, orgId, line.projectId, receiver.subsidiaryId, `line ${lineNumber} project`);
      const itemId = optionalId(raw.itemId, `line ${lineNumber} item`);
      let itemName: string | null = null;
      if (itemId) {
        const item = (await db.execute<{ name: string }>(sql`
          select name from items where org_id = ${orgId} and id = ${itemId}`)).rows[0];
        if (!item) throw new InternalBillingError(`line ${lineNumber}: item was not found`);
        itemName = item.name;
      }
      const isBillable = raw.isBillable == null
        ? rule.billableByDefault && internalBillingAllowsBillable(rule.method) && line.projectId != null
        : raw.isBillable === true;
      try {
        assertInternalBillingLine({
          method: rule.method,
          provider,
          receiver,
          lineProjectId: line.projectId,
          isBillable,
          multiSubsidiary,
          lineNumber,
        });
      } catch (error) {
        refusal(error);
      }
      const billRate = isBillable ? moneyOrNull(raw.billRate, "bill rate", lineNumber) ?? rate : null;
      prepared.push({
        itemId,
        description: optionalText(raw.description, `line ${lineNumber} description`, 1000) ?? itemName,
        quantity,
        rate,
        amount,
        ...line,
        isBillable,
        billRate,
        billAmount: billRate == null ? null : enteredRate == null && raw.billRate == null ? amount : extend(quantity, billRate),
      });
    }
    const total = sum(prepared.map((line) => line.amount));

    let id: string;
    let documentNumber: string;
    const before = existing ? await captureTransactionAuditSnapshot(db, existing.id, orgId) : null;
    if (existing) {
      const updated = await db.execute<{ id: string }>(sql`
        update documents
           set document_date = ${documentDate}::date, currency = ${currency}, subsidiary_id = ${providerSubsidiaryId},
               department_id = ${header.departmentId}, project_id = ${header.projectId},
               location_id = ${header.locationId}, class_id = ${header.classId},
               internal_billing_rule_id = ${rule.id}, reference_number = ${referenceNumber}, memo = ${memo},
               subtotal = ${total}, tax_total = '0', total = ${total},
               updated_at = now(), updated_by = ${args.actorId}
         where org_id = ${orgId} and id = ${existing.id} and status = 'draft'
         returning id`);
      if (!updated.rows[0]) throw new InternalBillingError("this document changed while you were saving; reload and try again", 409);
      await db.execute(sql`delete from document_lines where org_id = ${orgId} and document_id = ${existing.id}`);
      id = existing.id;
      documentNumber = existing.documentNumber;
    } else {
      documentNumber = await nextDocumentNumber(orgId, KIND, NUMBER_PREFIX, providerSubsidiaryId);
      const inserted = (await db.execute<{ id: string }>(sql`
        insert into documents (org_id, kind, document_number, document_date, currency, status,
                               subsidiary_id, department_id, project_id, location_id, class_id,
                               internal_billing_rule_id, reference_number, memo,
                               subtotal, tax_total, total, created_by, updated_by)
        values (${orgId}, ${KIND}, ${documentNumber}, ${documentDate}::date, ${currency}, 'draft',
                ${providerSubsidiaryId}, ${header.departmentId}, ${header.projectId}, ${header.locationId}, ${header.classId},
                ${rule.id}, ${referenceNumber}, ${memo},
                ${total}, '0', ${total}, ${args.actorId}, ${args.actorId})
        returning id`)).rows[0];
      if (!inserted) throw new Error("internal billing insert returned no row");
      id = inserted.id;
    }
    for (const [index, line] of prepared.entries()) {
      await db.execute(sql`
        insert into document_lines (org_id, document_id, line_number, item_id, account_id, recovery_account_id,
                                    description, quantity, unit_price, amount,
                                    subsidiary_id, department_id, project_id, location_id, class_id,
                                    is_billable, bill_rate, bill_amount, created_by)
        values (${orgId}, ${id}, ${index + 1}, ${line.itemId}, ${rule.debitAccountId}, ${rule.creditAccountId},
                ${line.description}, ${line.quantity}, ${line.rate}, ${line.amount},
                ${line.subsidiaryId}, ${line.departmentId}, ${line.projectId}, ${line.locationId}, ${line.classId},
                ${line.isBillable}, ${line.billRate}, ${line.billAmount}, ${args.actorId})`);
    }
    const after = await captureTransactionAuditSnapshot(db, id, orgId);
    if (existing && before && after) {
      await recordTransactionAudit(db, { orgId, documentId: id, action: "update", actorId: args.actorId, source: "internal_billing", before, after });
    } else if (after) {
      await db.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${orgId}, 'documents', ${id}, 'insert', ${JSON.stringify({ after })}::jsonb, ${args.actorId})`);
    }
    const revision = (await db.execute<{ revision: string }>(sql`
      select ${documentRevisionCounterSql(sql.raw("revision_seq"))} as revision
        from documents where org_id = ${orgId} and id = ${id}`)).rows[0]!.revision;
    return { id, documentNumber, status: "draft", revision };
  });
}

export type InternalBillingPostOutcome =
  | { status: "posted"; entryId: string }
  | { status: "pending_approval"; requestId: string | null };

/**
 * Submit and post through the native lifecycle in one unit: an approval
 * flow that gates the document leaves it pending; otherwise it is released
 * and posted, and a posting refusal rolls the release back with it.
 */
export async function postInternalBilling(args: {
  orgId: string;
  actorId: string;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
  id: string;
}): Promise<InternalBillingPostOutcome> {
  const { orgId, actorId } = args;
  if (!isUuid(args.id)) throw new InternalBillingError("not found", 404);
  const outcome = await withOrgTransaction(orgId, async () => {
    const current = (await db.execute<{ kind: string; status: string; subsidiaryId: string | null }>(sql`
      select kind, status, subsidiary_id as "subsidiaryId" from documents
       where org_id = ${orgId} and id = ${args.id}
       for update`)).rows[0];
    if (!current || current.kind !== KIND || !subsidiaryScopeAllows(args.allowedSubsidiaryIds, current.subsidiaryId)) {
      throw new InternalBillingError("not found", 404);
    }
    if (!(await lockAndCheckOrgFeature(db, orgId, "internalBilling"))) {
      throw new InternalBillingError(INTERNAL_BILLING_DISABLED, 404);
    }
    const previousStatus = current.status;
    if (previousStatus === "draft") {
      const submission = await submitAndReleaseIfUngated(KIND, args.id, actorId);
      if (submission.flowError) throw new InternalBillingError(`approval could not be routed: ${submission.flowError}`);
      if (submission.gated) {
        await db.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
          values (${orgId}, 'documents', ${args.id}, 'submit', ${JSON.stringify({ from: "draft", to: "pending_approval", run_id: submission.runId })}::jsonb, ${actorId})`);
        return { status: "pending_approval" as const, requestId: submission.runId ?? null, previousStatus };
      }
      await db.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${orgId}, 'documents', ${args.id}, 'submit', ${JSON.stringify({ from: "draft", to: "approved", auto_approved: true })}::jsonb, ${actorId}),
               (${orgId}, 'documents', ${args.id}, 'approve', ${JSON.stringify({ from: "draft", to: "approved", auto: true, reason: "released without approval: no approval flow configured" })}::jsonb, ${actorId})`);
    } else if (previousStatus !== "approved") {
      throw new InternalBillingError(`this document is ${previousStatus}; only a draft or approved document can be posted`);
    }
    const entryId = await postDocument(args.id, await controlDeps(orgId), {
      deferEffects: true,
      audit: { actorId, source: "ui" },
    });
    return { status: "posted" as const, entryId, previousStatus };
  });
  if (outcome.status === "pending_approval") return { status: "pending_approval", requestId: outcome.requestId };
  await runPostDocumentEffects(args.id, outcome.previousStatus, { actorId });
  return { status: "posted", entryId: outcome.entryId };
}

/**
 * Void through the native controlled void (reversal journal, before_void
 * approvals). The void service refuses while a customer invoice still bills
 * a line; voiding or deleting that invoice releases it.
 */
export async function voidInternalBilling(args: {
  orgId: string;
  actorId: string;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
  id: string;
  reason: string;
  reversalDate?: string | null;
  expectedRevision?: string | null;
}): Promise<DocumentVoidResult> {
  const { orgId } = args;
  if (!isUuid(args.id)) throw new InternalBillingError("not found", 404);
  const current = (await db.execute<{ kind: string; subsidiaryId: string | null }>(sql`
    select kind, subsidiary_id as "subsidiaryId" from documents where org_id = ${orgId} and id = ${args.id}`)).rows[0];
  if (!current || current.kind !== KIND || !subsidiaryScopeAllows(args.allowedSubsidiaryIds, current.subsidiaryId)) {
    throw new InternalBillingError("not found", 404);
  }
  try {
    return await requestDocumentVoid({
      documentId: args.id,
      orgId,
      actorId: args.actorId,
      reason: args.reason,
      reversalDate: args.reversalDate ?? null,
      expectedUpdatedAt: args.expectedRevision ?? null,
      allowedSubsidiaryIds: args.allowedSubsidiaryIds,
      source: "ui",
    });
  } catch (error) {
    if (error instanceof ScopeNotFoundError) throw new InternalBillingError("not found", 404);
    throw error;
  }
}

export interface InternalBillingDetail {
  document: {
    id: string;
    documentNumber: string;
    status: string;
    documentDate: string;
    currency: string;
    subsidiaryId: string | null;
    departmentId: string | null;
    projectId: string | null;
    locationId: string | null;
    classId: string | null;
    referenceNumber: string | null;
    memo: string | null;
    total: string;
    postedEntryId: string | null;
    revision: string;
  };
  rule: Pick<InternalBillingRuleRow, "id" | "code" | "name" | "method" | "effectiveFrom" | "effectiveTo"> | null;
  lines: {
    id: string;
    lineNumber: number;
    itemId: string | null;
    description: string | null;
    quantity: string;
    rate: string;
    amount: string;
    subsidiaryId: string | null;
    departmentId: string | null;
    projectId: string | null;
    locationId: string | null;
    classId: string | null;
    isBillable: boolean;
    billRate: string | null;
    billAmount: string | null;
    billed: boolean;
  }[];
}

/** One document with its rule and lines, or null when missing or out of scope. */
export async function loadInternalBilling(
  orgId: string,
  id: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<InternalBillingDetail | null> {
  if (!isUuid(id)) return null;
  const document = (await db.execute<InternalBillingDetail["document"] & { kind: string; ruleId: string | null }>(sql`
    select d.id, d.kind, d.document_number as "documentNumber", d.status, d.document_date::text as "documentDate",
           d.currency, d.subsidiary_id as "subsidiaryId", d.department_id as "departmentId",
           d.project_id as "projectId", d.location_id as "locationId", d.class_id as "classId",
           d.reference_number as "referenceNumber", d.memo, d.total::text as total,
           d.posted_entry_id as "postedEntryId", d.internal_billing_rule_id as "ruleId",
           ${documentRevisionCounterSql(sql.raw("d.revision_seq"))} as revision
      from documents d
     where d.org_id = ${orgId} and d.id = ${id}`)).rows[0];
  if (!document || document.kind !== KIND || !subsidiaryScopeAllows(allowedSubsidiaryIds, document.subsidiaryId)) return null;
  const rule = document.ruleId
    ? (await db.execute<NonNullable<InternalBillingDetail["rule"]>>(sql`
        select id, code, name, method, effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo"
          from internal_billing_rules where org_id = ${orgId} and id = ${document.ruleId}`)).rows[0] ?? null
    : null;
  const lines = (await db.execute<InternalBillingDetail["lines"][number]>(sql`
    select id, line_number as "lineNumber", item_id as "itemId", description,
           quantity::text as quantity, unit_price::text as rate, amount::text as amount,
           subsidiary_id as "subsidiaryId", department_id as "departmentId", project_id as "projectId",
           location_id as "locationId", class_id as "classId", is_billable as "isBillable",
           bill_rate::text as "billRate", bill_amount::text as "billAmount",
           billed_by_line_id is not null as billed
      from document_lines
     where org_id = ${orgId} and document_id = ${id}
     order by line_number`)).rows;
  const { kind: _kind, ruleId: _ruleId, ...header } = document;
  return { document: header, rule, lines };
}

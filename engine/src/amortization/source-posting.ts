/**
 * Source-document amortization: vendor bill, journal and expense report
 * lines that name an amortization template post to the template's deferral
 * account instead of their own account, and the posting creates one
 * schedule per line in the same transaction, so the deferral balance and
 * its schedule always appear together.
 *
 * The routing is resolved before the posting rule runs (the rule reads it
 * from the posting dependencies); the schedule is created from the posted
 * journal line itself, so its amount, entity, book and dimensions are the
 * ledger's own figures in the entity's functional currency.
 */
import { sql } from "drizzle-orm";
import { fromUnits, toUnits } from "../money/money.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import type { SqlExecutor } from "../platform/db.ts";
import { AMORTIZATION_FEATURE_KEY, AMORTIZATION_FEATURE_REMEDY, AmortizationError } from "./errors.ts";
import {
  amortizationCurrencyExponent,
  insertPlanLines,
  nextScheduleNumber,
  recordScheduleEvent,
  type TemplateVersion,
} from "./internal.ts";
import { buildAmortizationPlan, planQuantum, resolveAmortizationTerm, termWeights } from "./plan.ts";
import { assertDeferralAccount, assertDestinationAccount, resolveTemplateVersion } from "./templates.ts";

/** Document kinds whose lines can defer through an amortization template. */
export { AMORTIZABLE_LINE_KINDS as AMORTIZABLE_DOCUMENT_KINDS } from "./source-fields.ts";
import { AMORTIZABLE_LINE_KINDS as AMORTIZABLE_DOCUMENT_KINDS, amortizationLineRefusal } from "./source-fields.ts";

export interface AmortizationSourceLine {
  id: string;
  lineNumber: number;
  accountId: string | null;
  amount: string;
  amortizationTemplateId: string | null;
  amortizationStartOn: string | null;
  amortizationEndOn: string | null;
  settlementType?: string | null;
}

export interface AmortizationRouting {
  documentLineId: string;
  lineNumber: number;
  template: TemplateVersion;
  deferralAccountId: string;
  destinationAccountId: string;
  serviceStartOn: string | null;
  serviceEndOn: string | null;
}

function lineRefusal(lineNumber: number, message: string, code: string, remedy: string): AmortizationError {
  return new AmortizationError(`Line ${lineNumber}: ${message}`, { code, remedy });
}

/**
 * Resolve the deferral routing for a document's lines. Returns an empty map
 * when no line names a template. Refuses by name when the feature is off,
 * the kind cannot amortize, or a line cannot defer (inventory, negative,
 * personal, unresolved template, wrong account types, missing service dates).
 */
export async function resolveAmortizationRouting(
  runner: SqlExecutor,
  doc: { orgId: string; kind: string; transactionDate: string },
  lines: readonly AmortizationSourceLine[],
  options: { inventoryLineIds?: ReadonlySet<string> } = {},
): Promise<Map<string, AmortizationRouting>> {
  const routed = new Map<string, AmortizationRouting>();
  const templated = lines.filter((line) => line.amortizationTemplateId);
  if (templated.length === 0) return routed;
  if (!AMORTIZABLE_DOCUMENT_KINDS.has(doc.kind)) {
    throw new AmortizationError(
      `Line ${templated[0]!.lineNumber} names an amortization template, but only vendor bill, journal and expense report lines amortize.`,
      {
        code: "amortization_kind_unsupported",
        remedy: "Clear the amortization template from the line, then post again.",
      },
    );
  }
  if (!(await lockAndCheckOrgFeature(runner, doc.orgId, AMORTIZATION_FEATURE_KEY))) {
    throw new AmortizationError(
      `Line ${templated[0]!.lineNumber} names an amortization template, but Expense amortization is off.`,
      {
        code: "amortization_feature_off",
        remedy: `${AMORTIZATION_FEATURE_REMEDY} Or clear the amortization template from the line, then post again.`,
      },
    );
  }
  for (const line of templated) {
    if (options.inventoryLineIds?.has(line.id)) {
      throw lineRefusal(
        line.lineNumber,
        "an inventory item line receives stock and cannot also defer through an amortization template.",
        "amortization_inventory_line",
        "Clear the amortization template from the inventory line, or bill the prepaid cost on a separate non-inventory line.",
      );
    }
    if (line.settlementType === "personal") {
      throw lineRefusal(
        line.lineNumber,
        "a personal expense is not a company cost and cannot be amortized.",
        "amortization_personal_line",
        "Clear the amortization template from the personal line.",
      );
    }
    if (toUnits(line.amount) <= 0n) {
      throw lineRefusal(
        line.lineNumber,
        "only a positive amount can be deferred and amortized.",
        "amortization_line_not_positive",
        "Clear the amortization template from credit or zero lines; record credits against the schedule as a reduction.",
      );
    }
    if (!line.accountId) {
      throw lineRefusal(line.lineNumber, "the line has no account.", "amortization_line_account_missing", "Choose the line's expense account.");
    }
    const template = await resolveTemplateVersion(runner, doc.orgId, line.amortizationTemplateId!, doc.transactionDate);
    // Validates the term now, so a line missing its service dates refuses
    // before anything posts.
    try {
      resolveAmortizationTerm(template.policy, {
        serviceStartOn: line.amortizationStartOn,
        serviceEndOn: line.amortizationEndOn,
        transactionDate: doc.transactionDate,
      });
    } catch (error) {
      if (error instanceof AmortizationError) {
        throw lineRefusal(line.lineNumber, error.message, error.code, error.remedy);
      }
      throw error;
    }
    await assertDeferralAccount(runner, doc.orgId, template.deferralAccountId);
    const destinationAccountId = template.destinationAccountId ?? line.accountId;
    if (destinationAccountId === template.deferralAccountId) {
      throw lineRefusal(
        line.lineNumber,
        "the line's account is the template's deferral account, so there is nothing to amortize into.",
        "amortization_destination_is_deferral",
        "Code the line to the expense account the cost belongs to; the template routes it to the prepaid account.",
      );
    }
    await assertDestinationAccount(runner, doc.orgId, destinationAccountId, `Line ${line.lineNumber}`);
    routed.set(line.id, {
      documentLineId: line.id,
      lineNumber: line.lineNumber,
      template,
      deferralAccountId: template.deferralAccountId,
      destinationAccountId,
      serviceStartOn: line.amortizationStartOn,
      serviceEndOn: line.amortizationEndOn,
    });
  }
  return routed;
}

const SOURCE_KINDS: Record<string, "vendor_bill" | "journal" | "expense_report"> = {
  vendor_bill: "vendor_bill",
  journal: "journal",
  expense_report: "expense_report",
};

/**
 * Create the schedules for a posted document inside its posting transaction.
 * `legs` pairs each routed document line with the journal line number its
 * deferral leg posted on. The journal line must be on the deferral account
 * with a positive amount, or the posting refuses rather than guess. A line
 * that already has a schedule (a retried unit) is left as it is.
 */
export async function createSchedulesForPostedDocument(
  runner: SqlExecutor,
  input: {
    orgId: string;
    documentId: string;
    documentKind: string;
    documentNumber: string;
    entryId: string;
    actorId: string | null;
    routing: ReadonlyMap<string, AmortizationRouting>;
    legs: readonly { documentLineId: string; journalLineNumber: number }[];
  },
): Promise<string[]> {
  if (input.routing.size === 0) return [];
  const sourceKind = SOURCE_KINDS[input.documentKind];
  if (!sourceKind) throw new AmortizationError(`Document kind ${input.documentKind} cannot source an amortization schedule.`);
  if (input.legs.length !== input.routing.size) {
    throw new AmortizationError(
      `Document ${input.documentNumber} routed ${input.routing.size} line(s) to a deferral account but posted ${input.legs.length} deferral leg(s).`,
      {
        status: 409,
        code: "amortization_leg_mismatch",
        remedy: "Review the document's custom GL scripts and allocation rules for the routed lines, then post again.",
      },
    );
  }
  const entry = (await runner.execute<{ book_id: string; posting_date: string }>(sql`
    select book_id, posting_date::text as posting_date from journal_entries
     where org_id = ${input.orgId} and id = ${input.entryId}`)).rows[0];
  if (!entry) throw new AmortizationError(`The posted entry for ${input.documentNumber} is not readable.`, { status: 409 });
  const created: string[] = [];
  for (const leg of input.legs) {
    const route = input.routing.get(leg.documentLineId);
    if (!route) throw new AmortizationError(`Document line ${leg.documentLineId} has no amortization routing.`, { status: 409 });
    const existing = (await runner.execute<{ id: string }>(sql`
      select id from expense_amortization_schedules
       where org_id = ${input.orgId} and source_line_id = ${leg.documentLineId}`)).rows[0];
    if (existing) continue;
    const posted = (await runner.execute<{
      account_id: string;
      amount: string;
      subsidiary_id: string;
      department_id: string | null;
      project_id: string | null;
      location_id: string | null;
      class_id: string | null;
      extra_dims: Record<string, string | null> | null;
      base_currency: string;
    }>(sql`
      select jl.account_id, jl.amount::text as amount, jl.subsidiary_id, jl.department_id, jl.project_id,
             jl.location_id, jl.class_id, jl.extra_dims, sub.base_currency
        from journal_lines jl
        join subsidiaries sub on sub.org_id = jl.org_id and sub.id = jl.subsidiary_id
       where jl.org_id = ${input.orgId} and jl.entry_id = ${input.entryId}
         and jl.line_number = ${leg.journalLineNumber}`)).rows[0];
    const amount = posted ? toUnits(posted.amount) : 0n;
    if (!posted || posted.account_id !== route.deferralAccountId || amount <= 0n) {
      throw new AmortizationError(
        `Line ${route.lineNumber} of ${input.documentNumber} did not post its deferral to the template's prepaid account.`,
        {
          status: 409,
          code: "amortization_leg_mismatch",
          remedy: "Review the document's custom GL scripts and allocation rules for the routed line, then post again.",
        },
      );
    }
    const term = resolveAmortizationTerm(route.template.policy, {
      serviceStartOn: route.serviceStartOn,
      serviceEndOn: route.serviceEndOn,
      transactionDate: entry.posting_date,
    });
    const exponent = await amortizationCurrencyExponent(runner, posted.base_currency);
    const plan = buildAmortizationPlan(route.template.policy, term, amount, planQuantum(amount, exponent));
    const weights = termWeights(route.template.policy, term);
    const scheduleNumber = await nextScheduleNumber(runner, input.orgId);
    const inserted = (await runner.execute<{ id: string }>(sql`
      insert into expense_amortization_schedules
        (org_id, schedule_number, status, source_kind, source_document_id, source_line_id, source_entry_id,
         template_id, method, term_source, period_offset, subsidiary_id, book_id, currency,
         total_amount, service_start_on, service_end_on, first_period_on,
         deferral_account_id, destination_account_id, department_id, project_id, location_id, class_id,
         extra_dims, memo, created_by, updated_by)
      values (${input.orgId}, ${scheduleNumber}, 'active', ${sourceKind}, ${input.documentId}, ${leg.documentLineId},
        ${input.entryId}, ${route.template.id}, ${route.template.policy.method}, ${route.template.policy.termSource},
        ${route.template.policy.periodOffset}, ${posted.subsidiary_id}, ${entry.book_id}, ${posted.base_currency},
        ${fromUnits(amount)}::numeric, ${term.startOn}, ${term.endOn}, ${term.firstPeriodOn},
        ${route.deferralAccountId}, ${route.destinationAccountId}, ${posted.department_id}, ${posted.project_id},
        ${posted.location_id}, ${posted.class_id}, ${JSON.stringify(posted.extra_dims ?? {})}::jsonb,
        ${`${input.documentNumber} line ${route.lineNumber}`}, ${input.actorId}, ${input.actorId})
      returning id`)).rows[0];
    if (!inserted) {
      throw new AmortizationError(`The amortization schedule for line ${route.lineNumber} was not stored.`, { status: 409 });
    }
    await insertPlanLines(runner, {
      orgId: input.orgId,
      scheduleId: inserted.id,
      planRevision: 1,
      lines: plan.map((period, index) => ({ ...period, weight: weights[index]! })),
      destinationAccountId: route.destinationAccountId,
      actorId: input.actorId,
    });
    await recordScheduleEvent(runner, {
      orgId: input.orgId,
      scheduleId: inserted.id,
      kind: "created",
      reason: `Deferred from ${input.documentNumber} line ${route.lineNumber}.`,
      effectiveOn: entry.posting_date,
      balanceDelta: amount,
      after: {
        scheduleNumber,
        status: "active",
        totalAmount: fromUnits(amount),
        template: { id: route.template.id, code: route.template.code, effectiveFrom: route.template.effectiveFrom },
        method: route.template.policy.method,
        serviceStartOn: term.startOn,
        serviceEndOn: term.endOn,
        firstPeriodOn: term.firstPeriodOn,
        periods: plan.length,
        deferralAccountId: route.deferralAccountId,
        destinationAccountId: route.destinationAccountId,
      },
      relatedDocumentId: input.documentId,
      journalEntryId: input.entryId,
      actorId: input.actorId,
    });
    created.push(inserted.id);
  }
  return created;
}

/**
 * The deferral account each scheduled line of a posted document holds, for
 * regenerating that document's ledger projection exactly as it posted.
 */
export async function scheduledDeferralByLine(
  runner: SqlExecutor,
  orgId: string,
  documentId: string,
): Promise<Map<string, { deferralAccountId: string }>> {
  const rows = (await runner.execute<{ source_line_id: string; deferral_account_id: string }>(sql`
    select source_line_id, deferral_account_id from expense_amortization_schedules
     where org_id = ${orgId} and source_document_id = ${documentId} and source_line_id is not null`)).rows;
  return new Map(rows.map((row) => [row.source_line_id, { deferralAccountId: row.deferral_account_id }]));
}

/** Validate the persisted draft through the same policy resolver used by posting. */
export async function validateSavedAmortizationLines(runner: SqlExecutor, orgId: string, documentId: string): Promise<void> {
  const document = (await runner.execute<{ kind: string; transactionDate: string }>(sql`
    select kind, document_date::text as "transactionDate" from documents
    where org_id = ${orgId} and id = ${documentId}`)).rows[0];
  if (!document) throw new AmortizationError("Document not found.", { status: 404 });
  const lines = (await runner.execute<AmortizationSourceLine>(sql`
    select id, line_number as "lineNumber", account_id as "accountId", amount::text as amount,
           amortization_template_id as "amortizationTemplateId", amortization_start_on::text as "amortizationStartOn",
           amortization_end_on::text as "amortizationEndOn", settlement_type as "settlementType"
    from document_lines where org_id = ${orgId} and document_id = ${documentId} order by line_number`)).rows;
  for (const line of lines) {
    const refusal = amortizationLineRefusal(document.kind, line);
    if (refusal) throw new AmortizationError(`Line ${line.lineNumber}: ${refusal}`);
  }
  await resolveAmortizationRouting(runner, { orgId, ...document }, lines);
}

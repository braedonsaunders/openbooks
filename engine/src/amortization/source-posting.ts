import { loadBookProfile, resolveBookBases } from "../journal/book-basis.ts";
import { applyBookAccountMaps } from "../journal/book-account-maps.ts";
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
 * ledger's own figures in that book's measurement currency.
 */
import { sql } from "drizzle-orm";
import { fromUnits, toUnits } from "../money/money.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import type { SqlExecutor } from "../platform/db.ts";
import {
  AMORTIZATION_FEATURE_KEY,
  AMORTIZATION_FEATURE_REMEDY,
  AmortizationError,
} from "./errors.ts";
import {
  amortizationCurrencyExponent,
  insertPlanLines,
  nextScheduleNumber,
  recordScheduleEvent,
  type TemplateVersion,
} from "./internal.ts";
import {
  buildAmortizationPlan,
  planQuantum,
  resolveAmortizationTerm,
  termWeights,
} from "./plan.ts";
import {
  assertDeferralAccount,
  assertDestinationAccount,
  loadTemplateVersion,
  resolveTemplateVersion,
} from "./templates.ts";

/** Document kinds whose lines can defer through an amortization template. */
export { AMORTIZABLE_LINE_KINDS as AMORTIZABLE_DOCUMENT_KINDS } from "./source-fields.ts";
import {
  AMORTIZABLE_LINE_KINDS as AMORTIZABLE_DOCUMENT_KINDS,
  amortizationLineRefusal,
} from "./source-fields.ts";

export type AmortizationSourceLine = {
  id: string;
  lineNumber: number;
  accountId: string | null;
  amount: string;
  amortizationTemplateId: string | null;
  amortizationStartOn: string | null;
  amortizationEndOn: string | null;
  settlementType?: string | null;
};

export interface AmortizationRouting {
  documentLineId: string;
  lineNumber: number;
  template: TemplateVersion;
  deferralAccountId: string;
  destinationAccountId: string;
  serviceStartOn: string | null;
  serviceEndOn: string | null;
}

function lineRefusal(
  lineNumber: number,
  message: string,
  code: string,
  remedy: string,
): AmortizationError {
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
      throw lineRefusal(
        line.lineNumber,
        "the line has no account.",
        "amortization_line_account_missing",
        "Choose the line's expense account.",
      );
    }
    const template = await resolveTemplateVersion(
      runner,
      doc.orgId,
      line.amortizationTemplateId!,
      doc.transactionDate,
    );
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
    await assertDestinationAccount(
      runner,
      doc.orgId,
      destinationAccountId,
      `Line ${line.lineNumber}`,
    );
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
  if (!sourceKind)
    throw new AmortizationError(
      `Document kind ${input.documentKind} cannot source an amortization schedule.`,
    );
  if (
    input.legs.length !== input.routing.size ||
    new Set(input.legs.map((leg) => leg.documentLineId)).size !== input.routing.size
  ) {
    throw new AmortizationError(
      `Document ${input.documentNumber} routed ${input.routing.size} line(s) to a deferral account but posted ${input.legs.length} deferral leg(s).`,
      {
        status: 409,
        code: "amortization_leg_mismatch",
        remedy:
          "Review the document's custom GL scripts and allocation rules for the routed lines, then post again.",
      },
    );
  }
  const entry = (
    await runner.execute<{ book_id: string; posting_date: string; transaction_date: string }>(
      sql`
    select e.book_id, e.posting_date::text as posting_date, d.document_date::text as transaction_date from journal_entries e
     join documents d on d.org_id = e.org_id and d.id = ${input.documentId}
     where e.org_id = ${input.orgId} and e.id = ${input.entryId}
       and e.source_document_id = d.id and e.reverses_entry_id is null`,
      "objects",
    )
  )[0];
  if (!entry)
    throw new AmortizationError(`The posted entry for ${input.documentNumber} is not readable.`, {
      status: 409,
    });
  const book = await loadBookProfile(runner, input.orgId, entry.book_id);
  if (!book)
    throw new AmortizationError("The source accounting book is unavailable.", { status: 409 });
  const created: string[] = [];
  for (const leg of input.legs) {
    const route = input.routing.get(leg.documentLineId);
    if (!route)
      throw new AmortizationError(
        `Document line ${leg.documentLineId} has no amortization routing.`,
        { status: 409 },
      );
    const existing = (
      await runner.execute<{ id: string }>(
        sql`
      select id from expense_amortization_schedules
       where org_id = ${input.orgId} and source_line_id = ${leg.documentLineId} and book_id = ${entry.book_id}`,
        "objects",
      )
    )[0];
    if (existing) continue;
    const posted = (
      await runner.execute<{
        account_id: string;
        amount: string;
        subsidiary_id: string;
        department_id: string | null;
        project_id: string | null;
        location_id: string | null;
        class_id: string | null;
        extra_dims: Record<string, string | null> | null;
        base_currency: string;
      }>(
        sql`
      select jl.account_id, jl.amount::text as amount, jl.subsidiary_id, jl.department_id, jl.project_id,
             jl.location_id, jl.class_id, jl.extra_dims, sub.base_currency
        from journal_lines jl
        join subsidiaries sub on sub.org_id = jl.org_id and sub.id = jl.subsidiary_id
       where jl.org_id = ${input.orgId} and jl.entry_id = ${input.entryId}
         and jl.line_number = ${leg.journalLineNumber}`,
        "objects",
      )
    )[0];
    if (!posted)
      throw new AmortizationError(`Line ${route.lineNumber} has no posted deferral leg.`, {
        status: 409,
      });
    const basis = (
      await resolveBookBases(runner, {
        orgId: input.orgId,
        book,
        subsidiaryIds: [posted.subsidiary_id],
        postingDate: entry.posting_date,
      })
    ).get(posted.subsidiary_id)!;
    const mapped = book.isPrimary
      ? {
          lines: [
            { accountId: route.deferralAccountId, subsidiaryId: posted.subsidiary_id },
            { accountId: route.destinationAccountId, subsidiaryId: posted.subsidiary_id },
          ],
        }
      : await applyBookAccountMaps(runner, {
          orgId: input.orgId,
          bookId: book.id,
          bookLabel: book.code,
          postingDate: entry.posting_date,
          entryLabel: input.documentNumber,
          lines: [
            { accountId: route.deferralAccountId, subsidiaryId: posted.subsidiary_id },
            { accountId: route.destinationAccountId, subsidiaryId: posted.subsidiary_id },
          ],
        });
    const deferralAccountId = mapped.lines[0]!.accountId;
    const destinationAccountId = mapped.lines[1]!.accountId;
    await assertDeferralAccount(runner, input.orgId, deferralAccountId);
    await assertDestinationAccount(
      runner,
      input.orgId,
      destinationAccountId,
      `Line ${route.lineNumber}`,
    );
    const amount = toUnits(posted.amount);
    if (posted.account_id !== deferralAccountId || amount <= 0n) {
      throw new AmortizationError(
        `Line ${route.lineNumber} of ${input.documentNumber} did not post its deferral to the template's prepaid account.`,
        {
          status: 409,
          code: "amortization_leg_mismatch",
          remedy:
            "Review the document's custom GL scripts and allocation rules for the routed line, then post again.",
        },
      );
    }
    const term = resolveAmortizationTerm(route.template.policy, {
      serviceStartOn: route.serviceStartOn,
      serviceEndOn: route.serviceEndOn,
      transactionDate: entry.transaction_date,
    });
    const exponent = await amortizationCurrencyExponent(runner, basis.bookCurrency);
    const plan = buildAmortizationPlan(
      route.template.policy,
      term,
      amount,
      planQuantum(amount, exponent),
    );
    const weights = termWeights(route.template.policy, term);
    const scheduleNumber = await nextScheduleNumber(runner, input.orgId);
    const inserted = (
      await runner.execute<{ id: string }>(
        sql`
      insert into expense_amortization_schedules
        (org_id, schedule_number, status, source_kind, source_document_id, source_line_id, source_entry_id,
         template_id, method, term_source, period_offset, subsidiary_id, book_id, currency,
         total_amount, service_start_on, service_end_on, first_period_on,
         deferral_account_id, destination_account_id, department_id, project_id, location_id, class_id,
         extra_dims, memo, created_by, updated_by)
      values (${input.orgId}, ${scheduleNumber}, 'active', ${sourceKind}, ${input.documentId}, ${leg.documentLineId},
        ${input.entryId}, ${route.template.id}, ${route.template.policy.method}, ${route.template.policy.termSource},
        ${route.template.policy.periodOffset}, ${posted.subsidiary_id}, ${entry.book_id}, ${basis.bookCurrency},
        ${fromUnits(amount)}::numeric, ${term.startOn}, ${term.endOn}, ${term.firstPeriodOn},
        ${deferralAccountId}, ${destinationAccountId}, ${posted.department_id}, ${posted.project_id},
        ${posted.location_id}, ${posted.class_id}, ${JSON.stringify(posted.extra_dims ?? {})}::jsonb,
        ${`${input.documentNumber} line ${route.lineNumber}`}, ${input.actorId}, ${input.actorId})
      returning id`,
        "objects",
      )
    )[0];
    if (!inserted) {
      throw new AmortizationError(
        `The amortization schedule for line ${route.lineNumber} was not stored.`,
        { status: 409 },
      );
    }
    await insertPlanLines(runner, {
      orgId: input.orgId,
      scheduleId: inserted.id,
      planRevision: 1,
      lines: plan.map((period, index) => ({ ...period, weight: weights[index]! })),
      destinationAccountId,
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
        bookId: entry.book_id,
        currency: basis.bookCurrency,
        template: {
          id: route.template.id,
          code: route.template.code,
          effectiveFrom: route.template.effectiveFrom,
        },
        method: route.template.policy.method,
        serviceStartOn: term.startOn,
        serviceEndOn: term.endOn,
        firstPeriodOn: term.firstPeriodOn,
        periods: plan.length,
        deferralAccountId,
        destinationAccountId,
      },
      relatedDocumentId: input.documentId,
      journalEntryId: input.entryId,
      actorId: input.actorId,
    });
    created.push(inserted.id);
  }
  return created;
}

/** Each posted book copy owns the deferral schedule measured by that copy. */
export async function createSchedulesForDocumentBooks(
  runner: SqlExecutor,
  input: Parameters<typeof createSchedulesForPostedDocument>[1],
): Promise<string[]> {
  const replicas = await runner.execute<{ id: string }>(
    sql`
    select replica_entry_id as id from book_entry_replications
    where org_id = ${input.orgId} and source_entry_id = ${input.entryId} and replica_entry_id is not null
    order by book_id`,
    "objects",
  );
  const created: string[] = [];
  for (const entryId of [input.entryId, ...replicas.map((row) => row.id)]) {
    created.push(...(await createSchedulesForPostedDocument(runner, { ...input, entryId })));
  }
  return created;
}

/** Full-book activation and catch-up retain the source's recorded policy and line attribution. */
export async function createSchedulesForReplicatedDocument(
  runner: SqlExecutor,
  input: { orgId: string; sourceEntryId: string; replicaEntryId: string; actorId: string },
): Promise<string[]> {
  const source = (
    await runner.execute<{ id: string; kind: string; number: string }>(
      sql`
    select d.id, d.kind, d.document_number as number from documents d
    join journal_entries e on e.org_id = d.org_id and e.source_document_id = d.id
    where e.org_id = ${input.orgId} and e.id = ${input.sourceEntryId} and e.reverses_entry_id is null`,
      "objects",
    )
  )[0];
  if (!source) return [];
  const schedules = await runner.execute<{
    source_line_id: string;
    template_id: string;
    deferral_account_id: string;
    destination_account_id: string;
    service_start_on: string;
    service_end_on: string;
    line_number: number;
    status: string;
    revision: number;
    hasPosted: boolean;
  }>(
    sql`
    select s.source_line_id, s.template_id, s.deferral_account_id, s.destination_account_id,
           s.service_start_on::text, s.service_end_on::text, l.line_number, s.status, s.revision,
           exists (select 1 from expense_amortization_schedule_lines p where p.org_id = s.org_id
             and p.schedule_id = s.id and p.status = 'posted') as "hasPosted"
    from expense_amortization_schedules s
    join document_lines l on l.org_id = s.org_id and l.id = s.source_line_id
    where s.org_id = ${input.orgId} and s.source_entry_id = ${input.sourceEntryId}
    order by l.line_number for share of s`,
    "objects",
  );
  if (schedules.length === 0) return [];
  if (
    schedules.some(
      (schedule) => schedule.status !== "active" || schedule.revision !== 1 || schedule.hasPosted,
    )
  ) {
    throw new AmortizationError(
      `Document ${source.number} has amortization history that cannot be reconstructed as a new deferral.`,
      {
        status: 409,
        code: "amortization_book_history",
        remedy:
          "Activate the book using opening balances from a date after this document and its amortization history, then create manual schedules in that book for the carried-in prepaid balances.",
      },
    );
  }
  const legs = await runner.execute<{ sourceLineId: string; lineNumber: number }>(
    sql`
    select custom->>'amortizationSourceLineId' as "sourceLineId", line_number as "lineNumber"
    from journal_lines where org_id = ${input.orgId} and entry_id = ${input.replicaEntryId}
      and custom->>'amortizationSourceLineId' is not null order by line_number`,
    "objects",
  );
  const routing = new Map<string, AmortizationRouting>();
  for (const schedule of schedules) {
    routing.set(schedule.source_line_id, {
      documentLineId: schedule.source_line_id,
      lineNumber: schedule.line_number,
      template: await loadTemplateVersion(runner, input.orgId, schedule.template_id),
      deferralAccountId: schedule.deferral_account_id,
      destinationAccountId: schedule.destination_account_id,
      serviceStartOn: schedule.service_start_on,
      serviceEndOn: schedule.service_end_on,
    });
  }
  return createSchedulesForPostedDocument(runner, {
    orgId: input.orgId,
    documentId: source.id,
    documentKind: source.kind,
    documentNumber: source.number,
    entryId: input.replicaEntryId,
    actorId: input.actorId,
    routing,
    legs: legs.map((leg) => ({
      documentLineId: leg.sourceLineId,
      journalLineNumber: leg.lineNumber,
    })),
  });
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
  const rows = await runner.execute<{ source_line_id: string; deferral_account_id: string }>(
    sql`
    select s.source_line_id, s.deferral_account_id from expense_amortization_schedules s
    join documents d on d.org_id = s.org_id and d.id = s.source_document_id
    join journal_entries e on e.org_id = d.org_id and e.id = d.posted_entry_id and e.book_id = s.book_id
     where s.org_id = ${orgId} and s.source_document_id = ${documentId} and s.source_line_id is not null`,
    "objects",
  );
  return new Map(
    rows.map((row) => [row.source_line_id, { deferralAccountId: row.deferral_account_id }]),
  );
}

/** Validate the persisted draft through the same policy resolver used by posting. */
export async function validateSavedAmortizationLines(
  runner: SqlExecutor,
  orgId: string,
  documentId: string,
): Promise<void> {
  const document = (
    await runner.execute<{ kind: string; transactionDate: string }>(
      sql`
    select kind, document_date::text as "transactionDate" from documents
    where org_id = ${orgId} and id = ${documentId}`,
      "objects",
    )
  )[0];
  if (!document) throw new AmortizationError("Document not found.", { status: 404 });
  const lines = await runner.execute<AmortizationSourceLine>(
    sql`
    select id, line_number as "lineNumber", account_id as "accountId", amount::text as amount,
           amortization_template_id as "amortizationTemplateId", amortization_start_on::text as "amortizationStartOn",
           amortization_end_on::text as "amortizationEndOn", settlement_type as "settlementType"
    from document_lines where org_id = ${orgId} and document_id = ${documentId} order by line_number`,
    "objects",
  );
  for (const line of lines) {
    const refusal = amortizationLineRefusal(document.kind, line);
    if (refusal) throw new AmortizationError(`Line ${line.lineNumber}: ${refusal}`);
  }
  await resolveAmortizationRouting(runner, { orgId, ...document }, lines);
}

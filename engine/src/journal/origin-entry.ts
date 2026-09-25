/**
 * Tagged-origin GL poster: the shared kernel poster for project labor and
 * recognition journals (mirrors depreciation). Book resolution, subsidiary
 * default, the period gate, dimension row locks and per-subsidiary balance,
 * then postEntry — plus the row-locked reversal primitive. Moved verbatim
 * from projects/recognition.ts (ARCH-MODULE-CYCLE C05); the project labor
 * posting that calls it stays in projects.
 */
import { and, eq, sql } from "drizzle-orm";
import { db, inDbTransaction, schema } from "../platform/db.ts";
import { reversalJournalLines } from "../records/reversal-journal-lines.ts";
import { loadSubsidiaryContext, validateSubsidiaryRestrictions, uuidArray } from "../organization/subsidiaries.ts";
import { businessToday, isIsoCalendarDate } from "../platform/business-date.ts";
import { sum, isZero } from "../money/money.ts";
import { assertPeriodModulesOpen, CloseError } from "../periods/period-policy.ts";
import { markEntryReversed, postEntry } from "./post-entry.ts";
import { resolveCoveringPeriod } from "../periods/period-resolution.ts";
type ProjectGlTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type ProjectGlExecutor = Pick<ProjectGlTransaction, "execute">;
export interface GlLine {
  accountId: string;
  amount: string; // signed: debit +, credit −
  projectId?: string | null;
  partyId?: string | null;
  memo?: string | null;
  departmentId?: string | null;
  locationId?: string | null;
  classId?: string | null;
  /** Legal entity for this leg; defaults to the entry header subsidiary. */
  subsidiaryId?: string | null;
  extraDims?: Record<string, string> | null;
  contributorKind?: "rule" | "script" | "app" | "intercompany" | null;
  /** Rule version / script / app id that contributed this line. */
  contributorRef?: string | null;
}

/**
 * Post a balanced, period-checked GL entry with a tagged origin — the shared
 * kernel poster for labor/recognition (mirrors depreciation.ts). Runs in its
 * own transaction; returns the entry id, or null when there is nothing to post.
 */
export async function postProjectGlEntry(opts: {
  orgId: string;
  actorId: string;
  origin: string;
  entryNumber: string;
  postingDate: string;
  memo: string;
  subsidiaryId?: string | null;
  /** Functional currency of line amounts when already resolved by the caller. */
  currency?: string;
  /** Target GL book; defaults to the active primary posting book. */
  bookId?: string | null;
  lines: GlLine[];
}): Promise<string | null> {
  return inDbTransaction((tx) => postProjectGlEntryWithinTransaction(tx, opts));
}

type ProjectGlEntryOptions = Parameters<typeof postProjectGlEntry>[0];

/**
 * Transaction-participating project poster. Callers that also own source-row
 * claims use this so journal creation and source stamping commit together.
 */
export async function postProjectGlEntryWithinTransaction(
  tx: ProjectGlTransaction,
  opts: ProjectGlEntryOptions,
): Promise<string | null> {
  const { orgId, actorId, origin, entryNumber, postingDate, memo, subsidiaryId, lines } = opts;
  if (!actorId) throw new Error("an attributable actor is required");
  // Strict calendar boundary: a non-day such as February 30 passes a naive
  // Date.parse guard (V8 rolls it into March) and would otherwise surface as
  // a 22008 from PostgreSQL instead of failing closed here.
  if (!isIsoCalendarDate(postingDate)) throw new Error("postingDate must be a valid YYYY-MM-DD date");
  if (lines.length === 0) return null;
  const bal = sum(lines.map((l) => l.amount));
  if (!isZero(bal)) throw new Error(`unbalanced project GL entry (${bal})`);

  let bookId = opts.bookId ?? null;
  if (bookId) {
    const override = (await tx.execute<{ id: string }>(sql`
      select id from accounting_books
       where org_id = ${orgId} and id = ${bookId} and is_active and posts_gl
       limit 1 for share`));
    if (!override.rows[0]) throw new Error("project GL posting requires an active posting book");
  } else {
    const book = (await tx.execute<{ id: string }>(sql`
      select id from accounting_books
       where org_id = ${orgId} and is_primary and is_active and posts_gl
       limit 1 for share`));
    bookId = book.rows[0]?.id ?? null;
  }
  if (!bookId) throw new Error("no active primary GL book");
  await tx.execute(sql`select id from subsidiaries where org_id=${orgId} order by id for share`);
  // journal_entries.subsidiary_id is NOT NULL. When the source row carries no
  // legal entity, the one authoritative org root is the default.
  let subId = subsidiaryId;
  if (!subId) {
    const s = (await tx.execute<{ id: string }>(sql`
      select id from subsidiaries where org_id = ${orgId} and is_active and not is_elimination
       and parent_id is null limit 1`));
    subId = s.rows[0]?.id ?? null;
  }
  if (!subId) throw new Error("project GL posting requires an active root subsidiary");
  const lineSubIds = [...new Set([subId, ...lines.map((l) => l.subsidiaryId).filter((id): id is string => !!id)])];
  const currencies = (await tx.execute<{ id: string; base_currency: string | null }>(sql`
    select id, nullif(trim(base_currency), '') as base_currency
      from subsidiaries
     where org_id = ${orgId} and id = any(${uuidArray(lineSubIds)}::uuid[]) and is_active
  `));
  const currencyBySub = new Map(currencies.rows.map((row) => [row.id, row.base_currency]));
  for (const lineSubId of lineSubIds) {
    if (!currencyBySub.get(lineSubId)) {
      throw new Error(`subsidiary ${lineSubId} has no configured functional currency`);
    }
  }
  const functionalCurrencies = new Set(lineSubIds.map((lineSubId) => currencyBySub.get(lineSubId)));
  if (functionalCurrencies.size > 1) {
    throw new Error("project GL posting requires one functional currency across all line subsidiaries");
  }
  const functionalCurrency = [...functionalCurrencies][0]!;
  if (opts.currency && opts.currency !== functionalCurrency) {
    throw new Error(`project GL currency ${opts.currency} does not match subsidiary functional currency ${functionalCurrency}`);
  }
  const currency = opts.currency ?? functionalCurrency;
  // Project journals are ordinary postings: the shared covering-period
  // resolver (default calendar, regular periods, deterministic).
  const covering = await resolveCoveringPeriod(tx, orgId, postingDate);
  if (!covering) throw new Error(`no accounting period covers ${postingDate}`);
  const periodId = covering.id;
  // One period gate: the shared GL check replaces the raw
  // period_module_is_closed predicate. Project journals are new activity,
  // not historical replay, so source-owned imported locks refuse exactly
  // like user locks.
  try {
    await assertPeriodModulesOpen(tx, {
      orgId,
      periodId,
      bookId,
      subsidiaryIds: [subId],
      modules: ["gl"],
    });
  } catch (error) {
    if (error instanceof CloseError) {
      throw new Error(`the GL period covering ${postingDate} is closed`);
    }
    throw error;
  }
  const accountIds = [...new Set(lines.map((line) => line.accountId))];
  await tx.execute(sql`select id from accounts where org_id=${orgId}
    and id=any(${uuidArray(accountIds)}::uuid[]) order by id for share`);
  const dimensionLocks: Array<{ table: "departments" | "projects" | "locations" | "classes"; id: string }> = [];
  for (const line of lines) {
    if (line.departmentId) dimensionLocks.push({ table: "departments", id: line.departmentId });
    if (line.locationId) dimensionLocks.push({ table: "locations", id: line.locationId });
    if (line.projectId) dimensionLocks.push({ table: "projects", id: line.projectId });
    if (line.classId) dimensionLocks.push({ table: "classes", id: line.classId });
  }
  const lockProjectIds = [...new Set(dimensionLocks.filter((d) => d.table === "projects").map((d) => d.id))];
  if (lockProjectIds.length) {
    await tx.execute(sql`select id from projects where org_id=${orgId}
      and id=any(${uuidArray(lockProjectIds)}::uuid[]) order by id for share`);
  }
  const lockDepartmentIds = [...new Set(dimensionLocks.filter((d) => d.table === "departments").map((d) => d.id))];
  if (lockDepartmentIds.length) {
    await tx.execute(sql`select id from departments where org_id=${orgId}
      and id=any(${uuidArray(lockDepartmentIds)}::uuid[]) order by id for share`);
  }
  const lockLocationIds = [...new Set(dimensionLocks.filter((d) => d.table === "locations").map((d) => d.id))];
  if (lockLocationIds.length) {
    await tx.execute(sql`select id from locations where org_id=${orgId}
      and id=any(${uuidArray(lockLocationIds)}::uuid[]) order by id for share`);
  }
  const lockClassIds = [...new Set(dimensionLocks.filter((d) => d.table === "classes").map((d) => d.id))];
  if (lockClassIds.length) {
    await tx.execute(sql`select id from classes where org_id=${orgId}
      and id=any(${uuidArray(lockClassIds)}::uuid[]) order by id for share`);
  }
  const postingSubsidiaryId = subId;
  const restrictedLines = lines.map((line) => ({ ...line, subsidiaryId: line.subsidiaryId ?? postingSubsidiaryId }));
  await validateSubsidiaryRestrictions(tx, {
    orgId, ctx: await loadSubsidiaryContext(tx, orgId), docSubsidiaryId: postingSubsidiaryId,
    lines: restrictedLines,
  });
  // Every legal entity's books balance on their own (the kernel enforces the
  // same per-subsidiary boundary at the deferred-constraint level).
  const bySubsidiary = new Map<string, string[]>();
  for (const line of restrictedLines) {
    const amounts = bySubsidiary.get(line.subsidiaryId) ?? [];
    amounts.push(line.amount);
    bySubsidiary.set(line.subsidiaryId, amounts);
  }
  for (const [lineSubId, amounts] of bySubsidiary) {
    const subtotal = sum(amounts);
    if (!isZero(subtotal)) {
      throw new Error(`unbalanced project GL entry for subsidiary ${lineSubId} (${subtotal})`);
    }
  }
  // Every journal write routes through the ONE ledger API: the project audit
  // payload travels with the posting instead of a second insert.
  const postedProject = await postEntry(tx, {
    orgId,
    bookId,
    subsidiaryId: subId,
    entryNumber,
    postingDate,
    periodId,
    memo,
    origin,
    actorId,
    currency,
    auditAction: "insert",
    requestId: "project_gl_post",
    auditChanges: {
      mode: "project_gl_post",
      origin,
      entryNumber,
      postingDate,
    },
    lines: lines.map((l) => ({
      accountId: l.accountId,
      subsidiaryId: l.subsidiaryId ?? subId,
      amount: l.amount,
      projectId: l.projectId,
      partyId: l.partyId,
      departmentId: l.departmentId,
      locationId: l.locationId,
      classId: l.classId,
      extraDims: l.extraDims,
      contributorKind: l.contributorKind,
      contributorRef: l.contributorRef,
      memo: l.memo ?? memo,
    })),
  });
  const eid = postedProject.entryId;
  return eid;
}

export interface ReverseProjectGlResult {
  status: "reversed" | "already_reversed" | "missing";
  reversalId: string | null;
}

/**
 * Row-locked reversal primitive. The source row is the serialization point, so
 * overlapping workers can never create two mirrors for one posted entry.
 */
export async function reverseProjectGlEntryWithinTransaction(
  tx: ProjectGlTransaction,
  orgId: string,
  actorId: string,
  entryId: string,
  reasonInput: string,
  reversalDateInput?: string,
): Promise<ReverseProjectGlResult> {
  if (!actorId) throw new Error("an attributable actor is required");
  const reason = reasonInput.trim();
  if (reason.length < 5 || reason.length > 500) {
    throw new Error("a reversal reason between 5 and 500 characters is required");
  }
  // Business-meaningful default date: the org's calendar day (not the UTC
  // day), still honouring a pinned simulation clock (clock.ts) so a reversal
  // lands in the simulated period.
  const reversalDate =
    reversalDateInput ?? await businessToday(orgId);
  if (!isIsoCalendarDate(reversalDate)) {
    throw new Error("reversalDate must be a valid YYYY-MM-DD date");
  }
  const head = (await tx.execute<{
    entry_number: string;
    book_id: string;
    subsidiary_id: string;
    period_id: string;
    posting_date: string;
    origin: string;
    status: string;
  }>(sql`
    select entry_number, book_id, subsidiary_id, period_id, posting_date, origin, status
      from journal_entries
     where id = ${entryId} and org_id = ${orgId}
     for update`));
  const h = head.rows[0];
  if (!h) return { status: "missing", reversalId: null };
  if (h.status === "reversed") {
    const existing = (await tx.execute<{ id: string }>(sql`
      select id
        from journal_entries
       where org_id = ${orgId} and reverses_entry_id = ${entryId}
       order by created_at, id
       limit 1`));
    return {
      status: "already_reversed",
      reversalId: existing.rows[0]?.id ?? null,
    };
  }
  if (h.status !== "posted") {
    throw new Error(`project GL entry ${entryId} is ${h.status} and cannot be reversed`);
  }
  // Reversals are ordinary corrections: shared covering-period resolver.
  const period = await resolveCoveringPeriod(tx, orgId, reversalDate);
  if (!period) {
    throw new Error(`no accounting period covers ${reversalDate}`);
  }
  // One period gate: the shared GL check replaces the raw
  // period_module_is_closed predicate. A reversal is new activity, not
  // historical replay, so source-owned imported locks refuse exactly like
  // user locks.
  try {
    await assertPeriodModulesOpen(tx, {
      orgId,
      periodId: period.id,
      bookId: h.book_id,
      subsidiaryIds: [h.subsidiary_id],
      modules: ["gl"],
    });
  } catch (error) {
    if (error instanceof CloseError) {
      throw new Error(`the GL period covering ${reversalDate} is closed`);
    }
    throw error;
  }
  const lines = await tx.select().from(schema.journalLines)
    .where(and(eq(schema.journalLines.entryId, entryId), eq(schema.journalLines.orgId, orgId)))
    .orderBy(schema.journalLines.lineNumber);
  // Preserve the exact original FX and dimensional evidence. Losing location
  // (or any other dimension) leaves an un-reversed balance in that subledger.
  // The reversal posts through the ONE ledger API; the source entry is then
  // marked reversed — never edited.
  const mirror = reversalJournalLines(lines, { entryId: "", orgId });
  const postedReversal = await postEntry(tx, {
    orgId,
    bookId: h.book_id,
    subsidiaryId: h.subsidiary_id,
    entryNumber: h.entry_number + "-R",
    postingDate: reversalDate,
    periodId: period.id,
    memo: `Reversal of ${h.entry_number} — ${reason}`,
    origin: h.origin,
    reversesEntryId: entryId,
    actorId,
    auditAction: "update",
    requestId: "project_gl_reversal",
    auditChanges: {
      mode: "project_gl_reversal",
      reversedEntryId: entryId,
      reason,
      reversalDate,
    },
    lines: mirror.map((line) => ({
      accountId: line.accountId,
      subsidiaryId: line.subsidiaryId,
      amount: line.amount,
      currency: line.currency,
      txnAmount: line.txnAmount,
      fxRate: line.fxRate,
      memo: line.memo,
      partyId: line.partyId,
      departmentId: line.departmentId,
      projectId: line.projectId,
      locationId: line.locationId,
      classId: line.classId,
      equipmentUnitId: line.equipmentUnitId,
      extraDims: (line.extraDims ?? {}) as Record<string, unknown>,
      paymentCardId: line.paymentCardId,
      taxCodeId: line.taxCodeId,
      quantity: line.quantity,
      unit: line.unit,
      custom: (line.custom ?? {}) as Record<string, unknown>,
      contributorKind: line.contributorKind,
      contributorRef: line.contributorRef,
      lineNumber: line.lineNumber,
    })),
  });
  await markEntryReversed(tx, { orgId, entryId, actorId });
  return { status: "reversed", reversalId: postedReversal.entryId };
}

/** Reverse a posted origin-tagged entry (negated mirror, reverses_entry_id). */
export async function reverseProjectGlEntry(
  orgId: string,
  actorId: string,
  entryId: string,
  reason: string,
  reversalDate?: string,
): Promise<string | null> {
  const result = await inDbTransaction((tx) =>
    reverseProjectGlEntryWithinTransaction(
      tx,
      orgId,
      actorId,
      entryId,
      reason,
      reversalDate,
    )
  );
  return result.status === "reversed" ? result.reversalId : null;
}

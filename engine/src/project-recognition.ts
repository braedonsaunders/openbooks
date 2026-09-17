import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, inDbTransaction, schema } from "./db.ts";
import { reversalJournalLines } from "./reversal-journal-lines.ts";
import { loadSubsidiaryContext, validateSubsidiaryRestrictions, uuidArray } from "./subsidiaries.ts";
import { lockAndCheckOrgFeature } from "./org-feature-lock.ts";
import { businessToday, isIsoCalendarDate } from "./business-date.ts";
import { add, mul, neg, sum, isZero } from "./money.ts";
import { assertPeriodModulesOpen, CloseError } from "./close.ts";

/**
 * Project GL recognition — the accounting-correct layer on top of the billing
 * engine. Two flows, both gated on org control-account config (inert until the
 * accounts are mapped in Setup):
 *   • Labor → WIP at approval: DR labor WIP [project] / CR labor clearing.
 *   • Fixed-price revenue recognition: percent-complete DR unbilled receivable
 *     [project] / CR project revenue. The invoice later relieves unbilled
 *     receivable (see generateInvoiceFromBillingRequest), so revenue is
 *     recognized once, when earned — not double-counted at billing.
 *
 * All entries post through the kernel (balanced, period-checked) with a tagged
 * `origin`, exactly like depreciation/fx-revaluation.
 */

interface RecognitionAccounts {
  laborWip?: string;
  laborClearing?: string;
  unbilledReceivable?: string;
  projectRevenue?: string;
}

type ProjectGlTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type ProjectGlExecutor = Pick<ProjectGlTransaction, "execute">;

async function recognitionAccountsFrom(
  executor: ProjectGlExecutor,
  orgId: string,
  lock = false,
): Promise<RecognitionAccounts> {
  const r = (await executor.execute<{ c: Record<string, string> | null }>(sql`
    select settings->'controlAccounts' as c
      from orgs
     where id = ${orgId}
     ${lock ? sql`for share` : sql``}
  `));
  const c = r.rows[0]?.c ?? {};
  return {
    laborWip: c.laborWip,
    laborClearing: c.laborClearing,
    unbilledReceivable: c.unbilledReceivable,
    projectRevenue: c.projectRevenue,
  };
}

export async function recognitionAccounts(
  orgId: string,
  runner: Pick<typeof db, "execute"> = db,
): Promise<RecognitionAccounts> {
  return recognitionAccountsFrom(runner, orgId);
}

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
  const per = (await tx.execute<{ id: string }>(sql`
    select period.id
      from accounting_periods period
     where period.org_id = ${orgId} and period.is_adjustment = false
       and period.starts_on <= ${postingDate}
       and period.ends_on >= ${postingDate}
     limit 1`));
  const periodId = per.rows[0]?.id;
  if (!periodId) throw new Error(`no accounting period covers ${postingDate}`);
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
  const entry = (await tx.execute<{ id: string }>(sql`
    insert into journal_entries
      (org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, created_by, updated_by)
    values (${orgId}, ${bookId}, ${subId}, ${entryNumber}, ${postingDate}, ${periodId}, ${memo},
            'draft', ${origin}, ${actorId}, ${actorId})
    returning id`)).rows[0];
  if (!entry) throw new Error("project journal insert returned no entry");
  const eid = entry.id;
  let n = 1;
  for (const l of lines) {
    const lineSubId = l.subsidiaryId ?? subId;
    await tx.execute(sql`
      insert into journal_lines
        (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate,
         project_id, party_id, department_id, location_id, class_id, extra_dims,
         contributor_kind, contributor_ref, memo)
      values (${orgId}, ${eid}, ${n}, ${l.accountId}, ${lineSubId}, ${l.amount}, ${currency}, ${l.amount}, 1,
              ${l.projectId ?? null}, ${l.partyId ?? null},
              ${l.departmentId ?? null}, ${l.locationId ?? null}, ${l.classId ?? null},
              ${JSON.stringify(l.extraDims ?? {})}::jsonb,
              ${l.contributorKind ?? null}, ${l.contributorRef ?? null}, ${l.memo ?? memo})`);
    n++;
  }
  await tx.execute(sql`
    update journal_entries
       set status = 'posted', posted_at = now(), posted_by = ${actorId},
           updated_at = now(), updated_by = ${actorId}
     where id = ${eid} and org_id = ${orgId}`);
  await tx.execute(sql`
    insert into audit_log
      (org_id, table_name, row_id, action, changes, actor_id, request_id)
    values (
      ${orgId}, 'journal_entries', ${eid}, 'insert',
      ${JSON.stringify({
        mode: "project_gl_post",
        origin,
        entryNumber,
        postingDate,
      })}::jsonb,
      ${actorId}, 'project_gl_post'
    )
  `);
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
  const period = (await tx.execute<{ id: string }>(sql`
    select accounting_period.id
      from accounting_periods accounting_period
     where accounting_period.org_id = ${orgId}
       and not accounting_period.is_adjustment
       and accounting_period.starts_on <= ${reversalDate}
       and accounting_period.ends_on >= ${reversalDate}
     limit 1
  `));
  if (!period.rows[0]) {
    throw new Error(`no accounting period covers ${reversalDate}`);
  }
  // One period gate: the shared GL check replaces the raw
  // period_module_is_closed predicate. A reversal is new activity, not
  // historical replay, so source-owned imported locks refuse exactly like
  // user locks.
  try {
    await assertPeriodModulesOpen(tx, {
      orgId,
      periodId: period.rows[0].id,
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
  const rev = (await tx.execute<{ id: string }>(sql`
    insert into journal_entries
      (org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, reverses_entry_id, created_by, updated_by)
    values (${orgId}, ${h.book_id}, ${h.subsidiary_id}, ${h.entry_number + "-R"}, ${reversalDate}, ${period.rows[0].id},
            ${`Reversal of ${h.entry_number} — ${reason}`}, 'draft', ${h.origin}, ${entryId}, ${actorId}, ${actorId})
    returning id`)).rows[0]!;
  // Preserve the exact original FX and dimensional evidence. Losing location
  // (or any other dimension) leaves an un-reversed balance in that subledger.
  if (lines.length) await tx.insert(schema.journalLines).values(
    reversalJournalLines(lines, { entryId: rev.id, orgId }),
  );
  await tx.execute(sql`
    update journal_entries
       set status = 'posted', posted_at = now(), posted_by = ${actorId},
           updated_at = now(), updated_by = ${actorId}
     where id = ${rev.id} and org_id = ${orgId}`);
  await tx.execute(sql`
    update journal_entries
       set status = 'reversed', updated_at = now(), updated_by = ${actorId}
     where id = ${entryId} and org_id = ${orgId}`);
  await tx.execute(sql`
    insert into audit_log
      (org_id, table_name, row_id, action, changes, actor_id, request_id)
    values (
      ${orgId}, 'journal_entries', ${entryId}, 'update',
      ${JSON.stringify({
        mode: "project_gl_reversal",
        reason,
        reversalDate,
      })}::jsonb,
      ${actorId}, 'project_gl_reversal'
    )
  `);
  return { status: "reversed", reversalId: rev.id };
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

/* ------------------------------------------------------------------ */
/* Labor cost → WIP at approval                                        */
/* ------------------------------------------------------------------ */

/**
 * Post the labor cost of approved time to the ledger: DR labor WIP per project
 * (Σ hours × cost_rate), CR labor clearing (total). No-op unless both accounts
 * are configured and there is nonzero costed time. Stamps
 * time_entries.cost_journal_entry_id so it is never re-posted. Call after time
 * transitions to approved.
 */
export type LaborPostingSourceRow = {
  id: string;
  project_id: string;
  hours: string;
  cost_rate: string | null;
  worked_on: string;
  subsidiary_id: string | null;
  cost_rate_currency: string;
};

export interface LaborPostingGroup {
  subsidiaryId: string | null;
  currency: string;
  postingDate: string;
  timeEntryIds: string[];
  projectCosts: Array<{ projectId: string; amount: string }>;
  total: string;
}

/** Keep every labor journal inside one legal entity while aggregating projects. */
export function groupLaborPostings(rows: LaborPostingSourceRow[]): LaborPostingGroup[] {
  const groups = new Map<string, { subsidiaryId: string | null; currency: string; postingDate: string; timeEntryIds: string[]; byProject: Map<string, string> }>();
  for (const row of rows) {
    // hours and cost_rate are both money (numeric 19,4), so this is ordinary
    // money multiplication. It used mulRate — the FX helper, which reads its
    // second argument as a numeric(19,10) rate and rejects anything <= 0. An
    // entry with no wage rate therefore threw instead of costing nothing,
    // making the isZero skip below unreachable for exactly the rows it exists
    // to skip, and reporting a missing cost rate as an "FX rate" fault.
    const cost = mul(String(row.hours ?? "0"), String(row.cost_rate ?? "0"));
    if (isZero(cost)) continue;
    const key = `${row.subsidiary_id ?? "__default__"}|${row.cost_rate_currency}`;
    const group = groups.get(key) ?? { subsidiaryId: row.subsidiary_id, currency: row.cost_rate_currency, postingDate: "", timeEntryIds: [], byProject: new Map<string, string>() };
    group.byProject.set(row.project_id, add(group.byProject.get(row.project_id) ?? "0", cost));
    group.timeEntryIds.push(row.id);
    if (row.worked_on > group.postingDate) group.postingDate = row.worked_on;
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const projectCosts = [...group.byProject].map(([projectId, amount]) => ({ projectId, amount }));
    return {
      subsidiaryId: group.subsidiaryId,
      currency: group.currency,
      postingDate: group.postingDate,
      timeEntryIds: group.timeEntryIds,
      projectCosts,
      total: sum(projectCosts.map((project) => project.amount)),
    };
  });
}

export async function postProjectLaborCost(orgId: string, actorId: string, timeEntryIds: string[]): Promise<string[]> {
  if (timeEntryIds.length === 0) return [];
  return inDbTransaction(async (tx) => {
    // Hold the settings row through commit so an account remap cannot split
    // one approval batch across two control-account policies.
    const accts = await recognitionAccountsFrom(tx, orgId, true);
    if (!(await lockAndCheckOrgFeature(tx, orgId, "projects"))) return [];
    if (!accts.laborWip || !accts.laborClearing) return []; // inert until mapped
    const idArr = `{${timeEntryIds.join(",")}}`;
    const rows = (await tx.execute<LaborPostingSourceRow>(sql`
      select te.id, te.project_id, te.hours, te.cost_rate, te.worked_on,
             coalesce(p.subsidiary_id, te.cost_rate_subsidiary_id) as subsidiary_id,
             coalesce(te.cost_rate_currency, s.base_currency, o.base_currency) as cost_rate_currency
        from time_entries te
        left join projects p on p.id = te.project_id and p.org_id = te.org_id
        left join subsidiaries s on s.id = p.subsidiary_id and s.org_id = p.org_id
        join orgs o on o.id = te.org_id
       where te.org_id = ${orgId} and te.id = any(${idArr}::uuid[])
         and te.status = 'approved' and te.project_id is not null
         and te.cost_journal_entry_id is null
       order by te.id
       for update of te`));
    if (rows.rows.length === 0) return [];

    const entryIds: string[] = [];
    for (const group of groupLaborPostings(rows.rows)) {
      const lines: GlLine[] = group.projectCosts.map((project) => ({
        accountId: accts.laborWip!,
        amount: project.amount,
        projectId: project.projectId,
        memo: "Labor cost",
      }));
      lines.push({ accountId: accts.laborClearing, amount: neg(group.total), memo: "Labor clearing" });
      const postingDate = group.postingDate || await businessToday(orgId);
      // A released group (reverseProjectLaborCost) can be re-posted with the
      // same date and first member, so the entry number must be unique per
      // physical journal under journal_entries_org_number.
      const entryId = await postProjectGlEntryWithinTransaction(tx, {
        orgId,
        actorId,
        origin: "labor_burden",
        entryNumber: `LAB-${postingDate}-${group.timeEntryIds[0]!.slice(0, 8)}-${randomUUID().slice(0, 8)}`,
        postingDate,
        memo: "Approved labor cost → project WIP",
        subsidiaryId: group.subsidiaryId,
        currency: group.currency,
        lines,
      });
      if (!entryId) continue;
      const stamped = (await tx.execute<{ id: string }>(sql`
        update time_entries
           set cost_journal_entry_id = ${entryId},
               updated_at = now(),
               updated_by = ${actorId}
         where org_id = ${orgId}
           and id = any(${`{${group.timeEntryIds.join(",")}}`}::uuid[])
           and cost_journal_entry_id is null
         returning id`));
      if (stamped.rows.length !== group.timeEntryIds.length) {
        throw new Error("labor posting source claim changed before journal stamping");
      }
      entryIds.push(entryId);
    }
    return entryIds;
  });
}

/** Release labor-cost entries for time (reverse + clear the linkage). */
export async function reverseProjectLaborCost(
  orgId: string,
  actorId: string,
  timeEntryIds: string[],
  reason: string,
  reversalDate?: string,
): Promise<void> {
  if (timeEntryIds.length === 0) return;
  await inDbTransaction(async (tx) => {
    const idArr = `{${timeEntryIds.join(",")}}`;
    const linked = (await tx.execute<{ id: string; cost_journal_entry_id: string }>(sql`
      select id, cost_journal_entry_id
        from time_entries
       where org_id = ${orgId}
         and id = any(${idArr}::uuid[])
         and cost_journal_entry_id is not null
       order by id`));
    const entryIds = [...new Set(linked.rows.map((row) => row.cost_journal_entry_id))].sort();
    for (const entryId of entryIds) {
      // Lock the journal before any member rows. Two callers may request
      // different entries carried by the same journal; row-first locking would
      // let each hold one member while waiting on the other (a deadlock).
      const reversal = await reverseProjectGlEntryWithinTransaction(
        tx,
        orgId,
        actorId,
        entryId,
        reason,
        reversalDate,
      );
      if (reversal.status === "missing") {
        throw new Error(`labor posting journal ${entryId} is missing`);
      }
      // A single journal carries every entry in its legal-entity/currency
      // group. Reversing it releases the entire group, not only the requested
      // entry; still-approved members can then be deterministically re-posted.
      await tx.execute(sql`
        update time_entries
           set cost_journal_entry_id = null,
               updated_at = now(),
               updated_by = ${actorId}
         where org_id = ${orgId}
           and cost_journal_entry_id = ${entryId}`);
    }
  });
}

// Fixed-price percent-complete revenue recognition moved to the ARM pipeline:
// see project-revenue.ts (syncProjectRevenueContracts) — the central
// recognition run posts it; there is no per-project posting entry point.

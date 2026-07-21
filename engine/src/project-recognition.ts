import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { add, mul, neg, sum, isZero } from "./money.ts";
import { resolveLaborRate } from "./labor-rates.ts";

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

type SqlExecutor = { execute(query: unknown): Promise<unknown> };

export async function recognitionAccounts(orgId: string, executor: SqlExecutor = db as unknown as SqlExecutor): Promise<RecognitionAccounts> {
  const r = (await executor.execute(sql`select settings->'controlAccounts' as c from orgs where id = ${orgId}`)) as unknown as {
    rows: { c: Record<string, string> | null }[];
  };
  const c = r.rows[0]?.c ?? {};
  return {
    laborWip: c.laborWip,
    laborClearing: c.laborClearing,
    unbilledReceivable: c.unbilledReceivable,
    projectRevenue: c.projectRevenue,
  };
}

interface GlLine {
  accountId: string;
  amount: string; // signed: debit +, credit −
  projectId?: string | null;
  departmentId?: string | null;
  locationId?: string | null;
  partyId?: string | null;
  memo?: string | null;
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
  lines: GlLine[];
}): Promise<string | null> {
  return db.transaction((tx) => postProjectGlEntryInTransaction(tx as unknown as SqlExecutor, opts));
}

/** Transaction-scoped kernel poster used when the business transition and its
 * ledger projection must commit atomically. */
export async function postProjectGlEntryInTransaction(executor: SqlExecutor, opts: {
  orgId: string;
  actorId: string;
  origin: string;
  entryNumber: string;
  postingDate: string;
  memo: string;
  subsidiaryId?: string | null;
  lines: GlLine[];
}): Promise<string | null> {
  const { orgId, actorId, origin, entryNumber, postingDate, memo, subsidiaryId, lines } = opts;
  if (lines.length === 0) return null;
  const bal = sum(lines.map((l) => l.amount));
  if (!isZero(bal)) throw new Error(`unbalanced project GL entry (${bal})`);
    const book = (await executor.execute(sql`
      select id from accounting_books where org_id = ${orgId} and is_active
       order by is_primary desc, code limit 1`)) as unknown as { rows: { id: string }[] };
    const bookId = book.rows[0]?.id;
    if (!bookId) throw new Error("no active GL book");
    const per = (await executor.execute(sql`
      select id from accounting_periods where org_id = ${orgId} and is_adjustment = false
       and starts_on <= ${postingDate} and ends_on >= ${postingDate} limit 1`)) as unknown as { rows: { id: string }[] };
    const periodId = per.rows[0]?.id;
    if (!periodId) throw new Error(`no accounting period covers ${postingDate}`);
    const org = (await executor.execute(sql`select base_currency from orgs where id = ${orgId}`)) as unknown as {
      rows: { base_currency: string }[];
    };
    const currency = org.rows[0]?.base_currency ?? "CAD";
    // journal_entries.subsidiary_id is NOT NULL — fall back to the org's default
    // (first non-elimination) subsidiary when the project/time carries none.
    let subId = subsidiaryId;
    if (!subId) {
      const s = (await executor.execute(sql`
        select id from subsidiaries where org_id = ${orgId} and is_active and not is_elimination
         order by name limit 1`)) as unknown as { rows: { id: string }[] };
      subId = s.rows[0]?.id ?? null;
    }
    const inserted = (await executor.execute(sql`
      insert into journal_entries
        (org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, created_by, updated_by)
      values (${orgId}, ${bookId}, ${subId}, ${entryNumber}, ${postingDate}, ${periodId}, ${memo},
              'draft', ${origin}, ${actorId}, ${actorId})
      returning id`)) as unknown as { rows: { id: string }[] };
    const [entry] = inserted.rows;
    const eid = entry.id;
    let n = 1;
    for (const l of lines) {
      await executor.execute(sql`
        insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate,
           project_id, department_id, location_id, party_id, memo)
        values (${orgId}, ${eid}, ${n}, ${l.accountId}, ${subId}, ${l.amount}, ${currency}, ${l.amount}, 1,
                ${l.projectId ?? null}, ${l.departmentId ?? null}, ${l.locationId ?? null}, ${l.partyId ?? null}, ${l.memo ?? memo})`);
      n++;
    }
    await executor.execute(sql`update journal_entries set status = 'posted', posted_at = now(), posted_by = ${actorId} where id = ${eid}`);
    return eid;
}

/** Reverse a posted origin-tagged entry (negated mirror, reverses_entry_id). */
export async function reverseProjectGlEntry(orgId: string, actorId: string, entryId: string): Promise<string | null> {
  return db.transaction(async (tx) => {
    const head = (await tx.execute(sql`
      select entry_number, book_id, subsidiary_id, period_id, posting_date, origin, status
        from journal_entries where id = ${entryId} and org_id = ${orgId}`)) as unknown as { rows: any[] };
    const h = head.rows[0];
    if (!h || h.status !== "posted") return null;
    const lines = (await tx.execute(sql`
      select account_id, amount, currency, txn_amount, project_id, department_id, location_id, party_id, memo, subsidiary_id
        from journal_lines where entry_id = ${entryId} order by line_number`)) as unknown as { rows: any[] };
    const [rev] = (await tx.execute(sql`
      insert into journal_entries
        (org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, reverses_entry_id, created_by, updated_by)
      values (${orgId}, ${h.book_id}, ${h.subsidiary_id}, ${h.entry_number + "-R"}, ${h.posting_date}, ${h.period_id},
              ${"Reversal of " + h.entry_number}, 'draft', ${h.origin}, ${entryId}, ${actorId}, ${actorId})
      returning id`)).rows as any[];
    let n = 1;
    for (const l of lines.rows) {
      await tx.execute(sql`
        insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate,
           project_id, department_id, location_id, party_id, memo)
        values (${orgId}, ${rev.id}, ${n}, ${l.account_id}, ${l.subsidiary_id}, ${neg(String(l.amount))}, ${l.currency},
                ${neg(String(l.txn_amount ?? l.amount))}, 1, ${l.project_id}, ${l.department_id}, ${l.location_id}, ${l.party_id}, ${l.memo})`);
      n++;
    }
    await tx.execute(sql`update journal_entries set status = 'posted', posted_at = now(), posted_by = ${actorId} where id = ${rev.id}`);
    await tx.execute(sql`update journal_entries set status = 'reversed' where id = ${entryId}`);
    return rev.id;
  });
}

/* ------------------------------------------------------------------ */
/* Labor cost → WIP at approval                                        */
/* ------------------------------------------------------------------ */

/**
 * Legacy/import repair entry point. New interactive approvals use
 * approveProjectLaborTime, which resolves the rates and posts atomically.
 */
export async function postProjectLaborCost(orgId: string, actorId: string, timeEntryIds: string[]): Promise<string | null> {
  if (timeEntryIds.length === 0) return null;
  const accts = await recognitionAccounts(orgId);
  if (!accts.laborWip || !accts.laborClearing) throw new Error("labor WIP and labor clearing control accounts must be configured");
  const idArr = `{${timeEntryIds.join(",")}}`;
  const rows = (await db.execute(sql`
    select te.id, te.project_id, te.hours, te.cost_rate, te.worked_on, p.subsidiary_id
      from time_entries te
      left join projects p on p.id = te.project_id
     where te.org_id = ${orgId} and te.id = any(${idArr}::uuid[])
       and te.status = 'approved' and te.project_id is not null and te.cost_journal_entry_id is null`)) as unknown as {
    rows: { id: string; project_id: string; hours: string; cost_rate: string | null; worked_on: string; subsidiary_id: string | null }[];
  };
  if (rows.rows.length === 0) return null;

  // Sum cost by project.
  const byProject = new Map<string, string>();
  const posted: string[] = [];
  let subsidiaryId: string | null = null;
  let maxDate = "";
  for (const r of rows.rows) {
    if (r.cost_rate == null) throw new Error(`approved time entry ${r.id} has no cost-rate snapshot`);
    const cost = mul(String(r.hours ?? "0"), String(r.cost_rate));
    if (isZero(cost)) continue;
    byProject.set(r.project_id, add(byProject.get(r.project_id) ?? "0", cost));
    posted.push(r.id);
    subsidiaryId = subsidiaryId ?? r.subsidiary_id;
    if (r.worked_on > maxDate) maxDate = r.worked_on;
  }
  if (byProject.size === 0) return null;

  const lines: GlLine[] = [];
  let total = "0";
  for (const [projectId, amt] of byProject) {
    lines.push({ accountId: accts.laborWip, amount: amt, projectId, memo: "Labor cost" });
    total = add(total, amt);
  }
  lines.push({ accountId: accts.laborClearing, amount: neg(total), memo: "Labor clearing" });

  const postingDate = maxDate || new Date().toISOString().slice(0, 10);
  const entryId = await postProjectGlEntry({
    orgId,
    actorId,
    origin: "labor_burden",
    entryNumber: `LAB-${postingDate}-${timeEntryIds[0].slice(0, 8)}`,
    postingDate,
    memo: "Approved labor cost → project WIP",
    subsidiaryId,
    lines,
  });
  if (entryId) {
    await db.execute(sql`update time_entries set cost_journal_entry_id = ${entryId} where org_id = ${orgId} and id = any(${`{${posted.join(",")}}`}::uuid[])`);
  }
  return entryId;
}

export interface ApproveLaborResult {
  approvedIds: string[];
  journalEntryIds: string[];
}

export interface LaborPostingGroup {
  subsidiaryId: string | null
  postingDate: string
  timeEntryIds: string[]
  byProject: Map<string, string>
  total: string
}

/** Exact, deterministic accounting grouping for approved standard labor. */
export function buildLaborPostingGroups(items: {
  timeEntryId: string
  projectId: string
  subsidiaryId: string | null
  workedOn: string
  standardCostAmount: string
}[]): LaborPostingGroup[] {
  const groups = new Map<string, LaborPostingGroup>();
  for (const item of items) {
    if (isZero(item.standardCostAmount)) continue;
    const key = `${item.subsidiaryId ?? "default"}|${item.workedOn}`;
    const group = groups.get(key) ?? {
      subsidiaryId: item.subsidiaryId,
      postingDate: item.workedOn,
      timeEntryIds: [],
      byProject: new Map<string, string>(),
      total: "0.0000",
    };
    group.timeEntryIds.push(item.timeEntryId);
    group.byProject.set(item.projectId, add(group.byProject.get(item.projectId) ?? "0", item.standardCostAmount));
    group.total = add(group.total, item.standardCostAmount);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.postingDate.localeCompare(b.postingDate) || String(a.subsidiaryId).localeCompare(String(b.subsidiaryId)));
}

/**
 * Approve one employee week as a single accounting transaction. Every
 * submitted entry receives its effective-dated rate snapshot and immutable
 * explanation before any approval status changes. Project labor is posted by
 * work date and subsidiary, so a week crossing a period or entity boundary is
 * never forced into the wrong accounting scope.
 */
export async function approveProjectLaborTime(input: {
  orgId: string;
  actorId: string;
  employeePartyId: string;
  from: string;
  to: string;
}): Promise<ApproveLaborResult> {
  return db.transaction(async (tx) => {
    const executor = tx as unknown as SqlExecutor;
    const selected = (await executor.execute(sql`
      select te.id, te.employee_party_id, te.worked_on, te.hours, te.time_type_id, te.item_id,
             te.project_id, te.project_task_id, te.department_id, te.location_id, te.is_billable,
             p.subsidiary_id
        from time_entries te
        left join projects p on p.id = te.project_id and p.org_id = te.org_id
       where te.org_id = ${input.orgId}
         and te.employee_party_id = ${input.employeePartyId}
         and te.worked_on >= ${input.from} and te.worked_on <= ${input.to}
         and te.status = 'submitted'
       order by te.worked_on, te.id
       for update of te`)) as unknown as { rows: any[] };
    if (selected.rows.length === 0) return { approvedIds: [], journalEntryIds: [] };

    const lockedProjects = new Set<string>();
    const resolvedRows: { row: any; standardCostAmount: string }[] = [];
    for (const row of selected.rows) {
      if (row.project_id && !lockedProjects.has(row.project_id)) {
        await executor.execute(sql`select id from projects where id = ${row.project_id} and org_id = ${input.orgId} for update`);
        lockedProjects.add(row.project_id);
      }
      const rate = await resolveLaborRate({
        orgId: input.orgId,
        employeePartyId: row.employee_party_id,
        projectId: row.project_id,
        projectTaskId: row.project_task_id,
        itemId: row.item_id,
        timeTypeId: row.time_type_id,
        departmentId: row.department_id,
        locationId: row.location_id,
        workedOn: String(row.worked_on),
        hours: String(row.hours),
        isBillable: Boolean(row.is_billable),
      }, executor);
      if (rate.lockProjectVersion && row.project_id) {
        await executor.execute(sql`
          update projects set labor_rate_locked_version_id = ${rate.rateVersionId},
                              labor_rate_lock_date = ${row.worked_on}, updated_at = now(), updated_by = ${input.actorId}
           where id = ${row.project_id} and org_id = ${input.orgId} and labor_rate_locked_version_id is null`);
      }
      await executor.execute(sql`delete from time_entry_rate_components where org_id = ${input.orgId} and time_entry_id = ${row.id}`);
      await executor.execute(sql`
        update time_entries
           set direct_cost_rate = ${rate.directCostRate}, burden_rate = ${rate.burdenRate}, cost_rate = ${rate.costRate},
               bill_rate = ${rate.billRate}, transfer_rate = ${rate.transferRate}, standard_cost_amount = ${rate.standardCostAmount},
               cost_rate_version_id = ${rate.rateVersionId}, bill_rate_version_id = ${rate.rateVersionId},
               rate_resolved_at = now(), rate_resolution_hash = ${rate.resolutionHash}, updated_at = now(), updated_by = ${input.actorId}
         where id = ${row.id} and org_id = ${input.orgId}`);
      for (const component of rate.components) {
        await executor.execute(sql`
          insert into time_entry_rate_components
            (org_id, time_entry_id, lane, source_line_id, source_component_id, code, name, method,
             source_currency, fx_rate, rate_per_hour, amount, sequence, explanation, created_by)
          values (${input.orgId}, ${row.id}, ${component.lane}, ${component.sourceLineId}, ${component.sourceComponentId},
                  ${component.code}, ${component.name}, ${component.method}, ${component.sourceCurrency}, ${component.fxRate},
                  ${component.ratePerHour}, ${component.amount}, ${component.sequence}, ${component.explanation}, ${input.actorId})`);
      }
      resolvedRows.push({ row, standardCostAmount: rate.standardCostAmount });
    }

    const projectCosts = resolvedRows.filter(({ row, standardCostAmount }) => row.project_id && !isZero(standardCostAmount));
    const journalEntryIds: string[] = [];
    if (projectCosts.length) {
      const accts = await recognitionAccounts(input.orgId, executor);
      if (!accts.laborWip || !accts.laborClearing) {
        throw new Error("labor WIP and labor clearing control accounts must be configured before approving project time");
      }
      const groups = buildLaborPostingGroups(projectCosts.map((item) => ({
        timeEntryId: item.row.id,
        projectId: item.row.project_id,
        subsidiaryId: item.row.subsidiary_id,
        workedOn: String(item.row.worked_on),
        standardCostAmount: item.standardCostAmount,
      })));
      for (const group of groups) {
        const lines: GlLine[] = [];
        for (const [projectId, amount] of group.byProject) {
          lines.push({ accountId: accts.laborWip, amount, projectId, memo: "Standard labor and burden" });
        }
        lines.push({ accountId: accts.laborClearing, amount: neg(group.total), memo: "Standard labor clearing" });
        const entryId = await postProjectGlEntryInTransaction(executor, {
          orgId: input.orgId,
          actorId: input.actorId,
          origin: "labor_burden",
          entryNumber: `LAB-${group.postingDate}-${group.timeEntryIds[0].slice(0, 8)}`,
          postingDate: group.postingDate,
          memo: "Approved labor cost to project WIP",
          subsidiaryId: group.subsidiaryId,
          lines,
        });
        if (entryId) {
          journalEntryIds.push(entryId);
          const ids = `{${group.timeEntryIds.join(",")}}`;
          await executor.execute(sql`update time_entries set cost_journal_entry_id = ${entryId} where org_id = ${input.orgId} and id = any(${ids}::uuid[])`);
        }
      }
    }

    const approvedIds = selected.rows.map((row) => row.id);
    const idArray = `{${approvedIds.join(",")}}`;
    await executor.execute(sql`
      update time_entries set status = 'approved', approved_by = ${input.actorId}, approved_at = now(),
                              updated_at = now(), updated_by = ${input.actorId}
       where org_id = ${input.orgId} and id = any(${idArray}::uuid[]) and status = 'submitted'`);
    return { approvedIds, journalEntryIds };
  });
}

/** Release labor-cost entries for time (reverse + clear the linkage). */
export async function reverseProjectLaborCost(orgId: string, actorId: string, timeEntryIds: string[]): Promise<void> {
  if (timeEntryIds.length === 0) return;
  const idArr = `{${timeEntryIds.join(",")}}`;
  const ent = (await db.execute(sql`
    select distinct cost_journal_entry_id from time_entries
     where org_id = ${orgId} and id = any(${idArr}::uuid[]) and cost_journal_entry_id is not null`)) as unknown as {
    rows: { cost_journal_entry_id: string }[];
  };
  for (const e of ent.rows) await reverseProjectGlEntry(orgId, actorId, e.cost_journal_entry_id);
  await db.execute(sql`update time_entries set cost_journal_entry_id = null where org_id = ${orgId} and id = any(${idArr}::uuid[])`);
}

// Fixed-price percent-complete revenue recognition moved to the ARM pipeline:
// see project-revenue.ts (syncProjectRevenueContracts) — the central
// recognition run posts it; there is no per-project posting entry point.

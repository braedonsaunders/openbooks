import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, inDbTransaction } from "../platform/db.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { businessToday } from "../platform/business-date.ts";
import { add, mul, neg, sum, isZero } from "../money/money.ts";
import type { GlLine, ProjectGlExecutor } from "../journal/origin-entry.ts";
import {
  postProjectGlEntryWithinTransaction,
  reverseProjectGlEntryWithinTransaction,
} from "../journal/origin-entry.ts";
export type { GlLine, ReverseProjectGlResult } from "../journal/origin-entry.ts";
export {
  postProjectGlEntry,
  postProjectGlEntryWithinTransaction,
  reverseProjectGlEntry,
  reverseProjectGlEntryWithinTransaction,
} from "../journal/origin-entry.ts";

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

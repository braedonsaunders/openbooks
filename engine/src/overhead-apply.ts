import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { postProjectGlEntry, reverseProjectGlEntry } from "./project-recognition.ts";
import { add, isZero, mulRate, neg } from "./money.ts";

/**
 * Overhead application — the NET-ZERO PAIR (the reference organization/source platform mechanism),
 * applied WITH the hours: when approved time lands on a job, its overhead
 * share (hours × the effective-dated PUBLISHED per-department rate) posts as
 *   DR overhead account [project]   — project-scoped ledger views carry burden
 *   CR overhead account [no tag]    — the account and company P&L net to ZERO
 * in the same moment the standard labor cost does. There is no month-end
 * "apply overhead" chore; the only batch operation is a BACKFILL for hours
 * approved before the mode was enabled (or imported already-approved).
 *
 * Each carried entry is stamped with overhead_journal_entry_id, so
 * application is idempotent per entry and reversible per entry — posted
 * history never restates when rates are republished.
 *
 * Deliberately reads the STANDARD published `overhead_rates` (not the live
 * engine): every posting is reproducible from the rate card in force on the
 * worked day.
 */

export interface OverheadApplicationSettings {
  mode: "report_only" | "net_zero_pair" | "off";
  /** The single "Overhead applied" account both legs post to. */
  accountId: string | null;
}

export async function overheadApplicationSettings(orgId: string): Promise<OverheadApplicationSettings> {
  const r = (await db.execute(sql`select settings->'overheadApplication' as c from orgs where id = ${orgId}`)) as unknown as {
    rows: { c: Partial<OverheadApplicationSettings> | null }[];
  };
  const c = r.rows[0]?.c ?? {};
  return {
    mode: c.mode === "net_zero_pair" ? "net_zero_pair" : c.mode === "off" ? "off" : "report_only",
    accountId: typeof c.accountId === "string" ? c.accountId : null,
  };
}

export interface OverheadApplyResult {
  entryId: string | null;
  total: string;
  entries: number;
  projects: number;
}

/**
 * Apply the overhead pair for a set of approved time entries (the approval
 * hook). Skips silently unless mode is net_zero_pair with an account mapped —
 * callers don't need to pre-check. Only entries that are approved, project-
 * tagged, not yet carried, whose project type doesn't opt out (overhead
 * method 'none'), and whose worked day has a published rate participate.
 */
export async function applyOverheadForTime(orgId: string, actorId: string, timeEntryIds: string[]): Promise<OverheadApplyResult> {
  const none: OverheadApplyResult = { entryId: null, total: "0", entries: 0, projects: 0 };
  if (timeEntryIds.length === 0) return none;
  const settings = await overheadApplicationSettings(orgId);
  if (settings.mode !== "net_zero_pair" || !settings.accountId) return none;

  const idArr = `{${timeEntryIds.join(",")}}`;
  const rows = (await db.execute(sql`
    select te.id, te.project_id, te.worked_on, (te.hours * r.rate_percent) as amount
      from time_entries te
      join overhead_rates r
        on r.org_id = te.org_id
       and r.rate_kind = 'per_hour'
       and (r.department_id is null or r.department_id = te.department_id)
       and r.effective_from <= te.worked_on
       and (r.effective_to is null or r.effective_to >= te.worked_on)
       -- most specific: a department rate beats the org-wide (null-dept) rate
       and not exists (
         select 1 from overhead_rates r2
          where r2.org_id = te.org_id and r2.rate_kind = 'per_hour'
            and r2.department_id = te.department_id and r.department_id is null
            and r2.effective_from <= te.worked_on
            and (r2.effective_to is null or r2.effective_to >= te.worked_on)
       )
     where te.org_id = ${orgId} and te.id = any(${idArr}::uuid[])
       and te.status = 'approved' and te.project_id is not null
       and te.overhead_journal_entry_id is null
       and not exists (
         select 1 from projects p
         join project_types pt on pt.id = p.project_type_id
        where p.id = te.project_id
          and pt.financial_profile->'overhead'->>'method' = 'none'
       )`)) as unknown as {
    rows: { id: string; project_id: string; worked_on: string; amount: string }[];
  };
  if (rows.rows.length === 0) return none;

  const byProject = new Map<string, string>();
  const carried: string[] = [];
  let total = "0";
  let maxDate = "";
  for (const r of rows.rows) {
    const amt = mulRate(String(r.amount), "1"); // normalize to 4dp money
    if (isZero(amt)) continue;
    byProject.set(r.project_id, add(byProject.get(r.project_id) ?? "0", amt));
    total = add(total, amt);
    carried.push(r.id);
    if (r.worked_on > maxDate) maxDate = r.worked_on;
  }
  if (isZero(total) || carried.length === 0) return none;

  const lines: { accountId: string; amount: string; projectId?: string | null; memo?: string }[] = [];
  for (const [projectId, amt] of byProject) {
    lines.push({ accountId: settings.accountId, amount: amt, projectId, memo: "Overhead applied" });
  }
  lines.push({ accountId: settings.accountId, amount: neg(total), projectId: null, memo: "Overhead applied — contra" });

  const postingDate = maxDate || new Date().toISOString().slice(0, 10);
  const entryId = await postProjectGlEntry({
    orgId,
    actorId,
    origin: "overhead_applied",
    entryNumber: `OVH-${postingDate}-${carried[0].slice(0, 8)}`,
    postingDate,
    memo: "Overhead applied with approved hours (net-zero pair)",
    lines,
  });
  if (entryId) {
    await db.execute(sql`
      update time_entries set overhead_journal_entry_id = ${entryId}
       where org_id = ${orgId} and id = any(${`{${carried.join(",")}}`}::uuid[]) and overhead_journal_entry_id is null`);
  }
  return { entryId, total, entries: carried.length, projects: byProject.size };
}

/** How many approved project hours aren't carrying overhead yet (for the
 * workspace's backfill affordance). Counts only entries a backfill could
 * actually carry — a published rate must cover the worked day. */
export async function countUnappliedOverheadTime(orgId: string): Promise<{ entries: number; hours: string }> {
  const r = (await db.execute(sql`
    select count(*)::int as entries, coalesce(sum(te.hours), 0) as hours
      from time_entries te
     where te.org_id = ${orgId} and te.status = 'approved' and te.project_id is not null
       and te.overhead_journal_entry_id is null
       and exists (
         select 1 from overhead_rates r
          where r.org_id = te.org_id and r.rate_kind = 'per_hour'
            and (r.department_id is null or r.department_id = te.department_id)
            and r.effective_from <= te.worked_on
            and (r.effective_to is null or r.effective_to >= te.worked_on)
       )
       and not exists (
         select 1 from projects p
         join project_types pt on pt.id = p.project_type_id
        where p.id = te.project_id
          and pt.financial_profile->'overhead'->>'method' = 'none'
       )`)) as unknown as { rows: { entries: number; hours: string }[] };
  return { entries: Number(r.rows[0]?.entries ?? 0), hours: String(r.rows[0]?.hours ?? "0") };
}

/**
 * Backfill: carry overhead for every eligible approved entry that predates
 * the mode being enabled (or arrived via import). Batched so a decade of
 * history doesn't build one giant journal.
 */
export async function backfillOverhead(orgId: string, actorId: string): Promise<{ entries: number; total: string; journals: number }> {
  let entries = 0;
  let total = "0";
  let journals = 0;
  // Loop until no eligible ids remain (each pass stamps what it carries).
  for (let guard = 0; guard < 200; guard++) {
    const ids = (await db.execute(sql`
      select te.id
        from time_entries te
       where te.org_id = ${orgId} and te.status = 'approved' and te.project_id is not null
         and te.overhead_journal_entry_id is null
         and exists (
           select 1 from overhead_rates r
            where r.org_id = te.org_id and r.rate_kind = 'per_hour'
              and (r.department_id is null or r.department_id = te.department_id)
              and r.effective_from <= te.worked_on
              and (r.effective_to is null or r.effective_to >= te.worked_on)
         )
         and not exists (
           select 1 from projects p
           join project_types pt on pt.id = p.project_type_id
          where p.id = te.project_id
            and pt.financial_profile->'overhead'->>'method' = 'none'
         )
       order by te.worked_on
       limit 2000`)) as unknown as { rows: { id: string }[] };
    if (ids.rows.length === 0) break;
    const res = await applyOverheadForTime(orgId, actorId, ids.rows.map((r) => r.id));
    if (!res.entryId) break; // nothing carriable in this batch → stop
    entries += res.entries;
    total = add(total, res.total);
    journals++;
  }
  return { entries, total, journals };
}

/** Reverse the overhead pairs carrying these entries (mirror of
 * reverseProjectLaborCost — for unapproval flows). */
export async function reverseOverheadForTime(orgId: string, actorId: string, timeEntryIds: string[]): Promise<void> {
  if (timeEntryIds.length === 0) return;
  const idArr = `{${timeEntryIds.join(",")}}`;
  const ent = (await db.execute(sql`
    select distinct overhead_journal_entry_id from time_entries
     where org_id = ${orgId} and id = any(${idArr}::uuid[]) and overhead_journal_entry_id is not null`)) as unknown as {
    rows: { overhead_journal_entry_id: string }[];
  };
  for (const e of ent.rows) await reverseProjectGlEntry(orgId, actorId, e.overhead_journal_entry_id);
  // Clear the stamp for EVERY entry the reversed journals carried (a journal
  // may carry entries outside the requested set — they must be re-appliable).
  for (const e of ent.rows) {
    await db.execute(sql`
      update time_entries set overhead_journal_entry_id = null
       where org_id = ${orgId} and overhead_journal_entry_id = ${e.overhead_journal_entry_id}`);
  }
}

/** List posted overhead applications (for the workspace history). */
export async function listOverheadApplications(orgId: string, limit = 24) {
  const r = (await db.execute(sql`
    select e.id, e.entry_number, e.posting_date::text as posting_date, e.memo, e.status,
           (select coalesce(sum(l.amount), 0) from journal_lines l where l.entry_id = e.id and l.project_id is not null) as applied_total,
           (select count(distinct l.project_id) from journal_lines l where l.entry_id = e.id and l.project_id is not null) as projects
      from journal_entries e
     where e.org_id = ${orgId} and e.origin = 'overhead_applied'
     order by e.posting_date desc, e.created_at desc
     limit ${limit}`)) as unknown as {
    rows: { id: string; entry_number: string; posting_date: string; memo: string; status: string; applied_total: string; projects: number }[];
  };
  return r.rows;
}

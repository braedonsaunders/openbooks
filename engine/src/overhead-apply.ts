import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { postProjectGlEntry, reverseProjectGlEntry } from "./project-recognition.ts";
import { add, isZero, mulRate, neg } from "./money.ts";

/**
 * Overhead application — the NET-ZERO PAIR (the Rassaun/NetSuite mechanism).
 *
 * For a period, each project's overhead share (Σ approved hours × the
 * effective-dated PUBLISHED per-department overhead rate) posts as
 *   DR overhead account [project]   — project-scoped ledger views carry burden
 *   CR overhead account [no tag]    — the account and company P&L net to ZERO
 * The real indirect costs stay untouched in their own accounts, so nothing
 * double-counts; a trial balance audits the mechanism for free (the account
 * must always net ~0).
 *
 * Deliberately reads the STANDARD published `overhead_rates` (not the live
 * engine): posted history should move only when a human/schedule publishes new
 * rates, and each posting is reproducible from the rate card in force.
 *
 * Idempotent per period: re-applying reverses the previous application entry
 * and posts a fresh one (month-end re-runs converge).
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

export interface OverheadApplicationResult {
  entryId: string | null;
  reversedEntryId: string | null;
  total: string;
  projects: number;
}

/**
 * Apply overhead pairs for [periodStart, periodEnd]. Returns the posted entry
 * (null when there is nothing to post — no rates, no hours, or mode is not
 * net_zero_pair unless `force`).
 */
export async function applyOverheadPairs(opts: {
  orgId: string;
  actorId: string;
  periodStart: string;
  periodEnd: string;
}): Promise<OverheadApplicationResult> {
  const { orgId, actorId, periodStart, periodEnd } = opts;
  const settings = await overheadApplicationSettings(orgId);
  if (settings.mode !== "net_zero_pair") throw new Error("overhead application mode is not net_zero_pair");
  if (!settings.accountId) throw new Error("overhead applied account is not configured");

  // Project × department hours × the standard rate effective on the worked day.
  const rows = (await db.execute(sql`
    select te.project_id, sum(te.hours * r.rate_percent) as amount
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
     where te.org_id = ${orgId} and te.status = 'approved' and te.project_id is not null
       and te.worked_on >= ${periodStart} and te.worked_on <= ${periodEnd}
       -- respect the project type's overhead policy: method 'none' opts out
       and not exists (
         select 1 from projects p
         join project_types pt on pt.id = p.project_type_id
        where p.id = te.project_id
          and pt.financial_profile->'overhead'->>'method' = 'none'
       )
     group by te.project_id
     having sum(te.hours * r.rate_percent) <> 0`)) as unknown as {
    rows: { project_id: string; amount: string }[];
  };

  // Idempotency: reverse the previous application for this period, if any.
  const prior = (await db.execute(sql`
    select id from journal_entries
     where org_id = ${orgId} and origin = 'overhead_applied' and status = 'posted'
       and entry_number = ${`OVH-${periodEnd}`}
     order by created_at desc limit 1`)) as unknown as { rows: { id: string }[] };
  let reversedEntryId: string | null = null;
  if (prior.rows[0]) reversedEntryId = await reverseProjectGlEntry(orgId, actorId, prior.rows[0].id);

  if (rows.rows.length === 0) return { entryId: null, reversedEntryId, total: "0", projects: 0 };

  let total = "0";
  const lines: { accountId: string; amount: string; projectId?: string | null; memo?: string }[] = rows.rows.map((r) => {
    const amt = mulRate(String(r.amount), "1"); // normalize to 4dp money
    total = add(total, amt);
    return { accountId: settings.accountId!, amount: amt, projectId: r.project_id, memo: "Overhead applied" };
  });
  if (isZero(total)) return { entryId: null, reversedEntryId, total: "0", projects: 0 };
  lines.push({ accountId: settings.accountId!, amount: neg(total), projectId: null, memo: "Overhead applied — contra" });

  const entryId = await postProjectGlEntry({
    orgId,
    actorId,
    origin: "overhead_applied",
    entryNumber: `OVH-${periodEnd}`,
    postingDate: periodEnd,
    memo: `Overhead applied ${periodStart} → ${periodEnd} (net-zero pair)`,
    lines,
  });
  return { entryId, reversedEntryId, total, projects: rows.rows.length };
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

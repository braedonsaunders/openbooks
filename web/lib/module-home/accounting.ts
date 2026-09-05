import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import { addCalendarDays, businessToday } from '@openbooks/engine/src/business-date.ts'
import { db } from '@openbooks/engine/src/db.ts'
import { getAuthz } from '../authz'
import { subsidiaryVisibleFilter } from '../subsidiaries'

/**
 * Accounting module home — one light round trip for the financial-control
 * workspace landing: the active close run's progress, ledger hygiene counts,
 * continuous-close open findings by severity, and the live-directory badges.
 * The Financial Health HERO is served separately by financialHealth() (the
 * light score core, NOT the 10-tab healthData() payload — that stays in
 * analytics).
 */

export interface AccountingHome {
  close: {
    runId: string | null
    periodName: string | null
    status: string | null
    tasksDone: number
    tasksTotal: number
    /** 0–100, null when no run exists. */
    progressPct: number | null
  }
  draftJournals: number
  postedJournals7d: number
  workItems: { critical: number; warning: number; info: number; total: number }
  badges: {
    accounts: number
    budgets: number
    assets: number
  }
}

type AccountingSubsidiaryScope = ReadonlySet<string> | null

/** A run's targets do not narrow its organization-wide diagnostic population. */
function closeRunScope(allowed: AccountingSubsidiaryScope) {
  return allowed === null ? sql`` : sql` and false`
}

/**
 * A budget scenario has no header subsidiary: its lines carry the account and
 * optional project dimensions that identify a legal entity. Count only a
 * scenario with at least one line and reject the whole scenario if any line
 * points at an entity outside the caller's set.
 */
function budgetScope(orgId: string, allowed: AccountingSubsidiaryScope, scenario: SQL) {
  if (allowed === null) return sql``
  const ids = [...allowed]
  if (ids.length === 0) return sql` and false`
  const idArray = sql`${`{${ids.join(',')}}`}::uuid[]`
  const hidden = sql`(
    (ba.subsidiary_id is not null and ba.subsidiary_id <> all(${idArray}))
    or (bp.subsidiary_id is not null and bp.subsidiary_id <> all(${idArray}))
  )`
  const visible = sql`(
    (ba.subsidiary_id is null or ba.subsidiary_id = any(${idArray}))
    and (bp.subsidiary_id is null or bp.subsidiary_id = any(${idArray}))
  )`
  return sql`
    and exists (
      select 1
        from budget_lines bl
        left join accounts ba on ba.id = bl.account_id and ba.org_id = bl.org_id
        left join projects bp on bp.id = bl.project_id and bp.org_id = bl.org_id
       where bl.org_id = ${orgId} and bl.scenario_id = ${scenario}
         and ${visible}
    )
    and not exists (
      select 1
        from budget_lines bl
        left join accounts ba on ba.id = bl.account_id and ba.org_id = bl.org_id
        left join projects bp on bp.id = bl.project_id and bp.org_id = bl.org_id
       where bl.org_id = ${orgId} and bl.scenario_id = ${scenario}
         and ${hidden}
    )`
}

/** Continuous-close findings are polymorphic. Keep only findings whose
 * subject can be resolved to a scoped account, reconciliation, document, or
 * budget scenario; period-level findings have no legal-entity dimension and
 * are omitted for restricted readers.
 */
function workItemScope(orgId: string, allowed: AccountingSubsidiaryScope) {
  if (allowed === null) return sql``
  const ids = [...allowed]
  if (ids.length === 0) return sql` and false`
  const idArray = sql`${`{${ids.join(',')}}`}::uuid[]`
  const accountVisible = sql`(a.subsidiary_id is null or a.subsidiary_id = any(${idArray}))`
  const documentVisible = sql`d.subsidiary_id = any(${idArray})`
  return sql` and (
    (w.subject_type = 'account' and exists (
      select 1 from accounts a
       where a.org_id = ${orgId} and a.id = w.subject_id and ${accountVisible}
    ))
    or (w.subject_type = 'reconciliation' and exists (
      select 1 from reconciliations reconciliation
      join accounts a on a.id = reconciliation.account_id and a.org_id = reconciliation.org_id
       where reconciliation.org_id = ${orgId} and reconciliation.id = w.subject_id
         and ${accountVisible}
    ))
    or (w.subject_type = 'documents' and exists (
      select 1 from documents d
       where d.org_id = ${orgId} and d.id = w.subject_id and ${documentVisible}
    ))
    or (w.subject_type = 'budget' ${budgetScope(orgId, allowed, sql.raw('w.subject_id'))})
  )`
}

export async function accountingHome(
  orgId: string,
  allowedSubsidiaryIds?: AccountingSubsidiaryScope,
): Promise<AccountingHome> {
  // The accounting page historically supplied only orgId. Resolve the same
  // request authz here when that argument is omitted so direct callers cannot
  // accidentally turn a restricted page into an org-wide dashboard. Explicit
  // null remains the deliberate unrestricted/super-admin view; an absent
  // authz context fails closed.
  let scope: AccountingSubsidiaryScope
  if (allowedSubsidiaryIds !== undefined) {
    scope = allowedSubsidiaryIds
  } else {
    const authz = await getAuthz()
    scope = authz?.user.orgId === orgId ? authz.allowedSubsidiaryIds : new Set<string>()
  }
  const ago7 = addCalendarDays(await businessToday(orgId), -7)
  const [closeRes, countsRes, workRes] = (await Promise.all([
    // Latest close run + its task progress ('complete'/'approved' = done).
    db.execute<any>(sql`
      select r.id, r.status, p.name as period_name,
             coalesce(t.total, 0) as tasks_total,
             coalesce(t.done, 0) as tasks_done
        from close_runs r
        join accounting_periods p on p.id = r.period_id and p.org_id = r.org_id
        left join lateral (
          select count(*) as total,
                 count(*) filter (where ct.status in ('complete', 'approved')) as done
            from close_run_tasks ct where ct.run_id = r.id and ct.org_id = r.org_id) t on true
       where r.org_id = ${orgId}
         ${closeRunScope(scope)}
       order by r.created_at desc
       limit 1
    `),
    db.execute(sql`
      select
        (select count(*) from journal_entries je where je.org_id = ${orgId} and je.status = 'draft'
          ${subsidiaryVisibleFilter(sql`je.subsidiary_id`, scope)}) as draft_journals,
        (select count(*) from journal_entries je where je.org_id = ${orgId} and je.status in ('posted', 'reversed')
          and je.posting_date >= ${ago7}
          ${subsidiaryVisibleFilter(sql`je.subsidiary_id`, scope)}) as posted_7d,
        (select count(*) from accounts a where a.org_id = ${orgId} and not a.is_summary and a.is_active
          ${scope === null ? sql`` : [...scope].length
            ? sql` and (a.subsidiary_id is null or a.subsidiary_id = any(${`{${[...scope].join(',')}}`}::uuid[]))`
            : sql` and false`}) as accounts,
        (select count(*) from budget_scenarios b where b.org_id = ${orgId}
          ${budgetScope(orgId, scope, sql.raw('b.id'))}) as budgets,
        (select count(*) from fixed_assets f where f.org_id = ${orgId}
          ${subsidiaryVisibleFilter(sql`f.subsidiary_id`, scope)}) as assets
    `),
    // Continuous-close open findings by severity.
    db.execute(sql`
      select severity, count(*) as n from ai_work_items w
       where w.org_id = ${orgId} and w.status = 'open'
         ${workItemScope(orgId, scope)}
       group by severity
    `),
  ]))

  const close = closeRes.rows[0]
  const counts = countsRes.rows[0] ?? {}
  const sev = new Map(workRes.rows.map((r) => [String(r.severity), Number(r.n)]))
  const workItems = {
    critical: sev.get('critical') ?? 0,
    warning: sev.get('warning') ?? 0,
    info: sev.get('info') ?? 0,
    total: [...sev.values()].reduce((a, n) => a + n, 0),
  }

  return {
    close: close
      ? {
          runId: close.id,
          periodName: close.period_name,
          status: close.status,
          tasksDone: Number(close.tasks_done),
          tasksTotal: Number(close.tasks_total),
          progressPct: Number(close.tasks_total) > 0 ? Math.round((Number(close.tasks_done) / Number(close.tasks_total)) * 100) : null,
        }
      : { runId: null, periodName: null, status: null, tasksDone: 0, tasksTotal: 0, progressPct: null },
    draftJournals: Number(counts.draft_journals ?? 0),
    postedJournals7d: Number(counts.posted_7d ?? 0),
    workItems,
    badges: {
      accounts: Number(counts.accounts ?? 0),
      budgets: Number(counts.budgets ?? 0),
      assets: Number(counts.assets ?? 0),
    },
  }
}

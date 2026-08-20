import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'

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

export async function accountingHome(orgId: string): Promise<AccountingHome> {
  const [closeRes, countsRes, workRes] = (await Promise.all([
    // Latest close run + its task progress ('complete'/'approved' = done).
    db.execute<any>(sql`
      select r.id, r.status, p.name as period_name,
             coalesce(t.total, 0) as tasks_total,
             coalesce(t.done, 0) as tasks_done
        from close_runs r
        join accounting_periods p on p.id = r.period_id
        left join lateral (
          select count(*) as total,
                 count(*) filter (where ct.status in ('complete', 'approved')) as done
            from close_run_tasks ct where ct.run_id = r.id) t on true
       where r.org_id = ${orgId}
       order by r.created_at desc
       limit 1
    `),
    db.execute<any>(sql`
      select
        (select count(*) from journal_entries je where je.org_id = ${orgId} and je.status = 'draft') as draft_journals,
        (select count(*) from journal_entries je where je.org_id = ${orgId} and je.status in ('posted', 'reversed')
          and je.posting_date >= current_date - 7) as posted_7d,
        (select count(*) from accounts a where a.org_id = ${orgId} and not a.is_summary and a.is_active) as accounts,
        (select count(*) from budget_scenarios b where b.org_id = ${orgId}) as budgets,
        (select count(*) from fixed_assets f where f.org_id = ${orgId}) as assets
    `),
    // Continuous-close open findings by severity.
    db.execute<any>(sql`
      select severity, count(*) as n from ai_work_items w
       where w.org_id = ${orgId} and w.status = 'open'
       group by severity
    `),
  ]))

  const close = closeRes.rows[0]
  const counts = countsRes.rows[0] ?? {}
  const sev = new Map(workRes.rows.map((r: any) => [String(r.severity), Number(r.n)]))
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

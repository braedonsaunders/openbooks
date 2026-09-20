import 'server-only'

import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { listInbox, type InboxItem } from '@openbooks/engine/src/inbox/index.ts'
import { qualificationSourceAvailable } from '@openbooks/engine/src/inbox/adapters/hrm-qualification-alert.ts'
import { findEmploymentsByParty } from '@openbooks/engine/src/hrm/employment-read.ts'
import { loadApprovalPerson, loadTeamEmploymentIdsForManager } from '@openbooks/engine/src/hrm/authorization.ts'
import { listMyReviews } from '@openbooks/engine/src/hrm/performance/performance-read.ts'
import { listLeaveTypes, timeBalanceAsOf } from '@openbooks/engine/src/hrm/leave-read.ts'
import { liveHomeAnnouncements } from '@/lib/setup/home-announcements'
import { inboxContext } from '@/lib/inbox-context'
import { can, type Authz } from '@/lib/authz'
import { isFeatureEnabled } from '@/lib/features'
import { hasAdminPersona } from './_widget-access'
import { permissionSetCovers } from '@/lib/permissions'
import type { DashboardLayoutData } from '@openbooks/schema'

/**
 * HR-15 persona homes as dashboard defaults: employee (everyone), manager
 * (direct reports through the structural team scope, or an approval-capable
 * grant), admin (admin.setup.manage, an hrm.*.manage grant, or
 * payroll.manage). Chosen by what the actor HOLDS, never by role name.
 */

export type Persona = 'admin' | 'manager' | 'employee'

function heldPermissions(authz: Authz): ReadonlySet<string> {
  return authz.permissions
}

export function hasApprovalGrant(authz: Authz): boolean {
  const permissions = heldPermissions(authz)
  if (permissionSetCovers(permissions, 'flows.manage')) return true
  for (const permission of permissions) {
    if (permission === '*' || permission.endsWith('.*')) {
      if (permissionSetCovers(new Set([permission]), 'flows.approve')) return true
      continue
    }
    if (permission.includes('.approve')) return true
  }
  return false
}

export async function teamEmploymentIds(authz: Authz, today: string): Promise<string[]> {
  let partyId: string | null = null
  try {
    partyId = (await loadApprovalPerson(db, authz.user.orgId, authz.user.id)).partyId
  } catch {
    return []
  }
  if (!partyId) return []
  const mine = await findEmploymentsByParty({ orgId: authz.user.orgId, actorId: authz.user.id, workerPartyId: partyId }).catch(() => [] as readonly string[])
  return loadTeamEmploymentIdsForManager(db, authz.user.orgId, [...mine], today).catch(() => [])
}

export async function resolvePersona(authz: Authz): Promise<Persona> {
  if (hasAdminPersona(authz)) return 'admin'
  if (hasApprovalGrant(authz)) return 'manager'
  const today = await businessToday(authz.user.orgId)
  if ((await teamEmploymentIds(authz, today)).length > 0) return 'manager'
  return 'employee'
}

export interface PersonaLayoutFlags {
  payroll: boolean
  hrm: boolean
  celebrations: boolean
  nudges: boolean
  announcements: boolean
  quals: boolean
}

/**
 * Default dashboard layouts per persona. Gated tiles are included only
 * when their source is live — a tile with nothing true to say never ships
 * in the default. Users who customized keep their layout (see
 * _load-layout.ts); everyone else recomputes this on every load.
 */
export function personaDefaultLayout(persona: Persona, flags: PersonaLayoutFlags): DashboardLayoutData {
  type Cell = DashboardLayoutData['widgets'][number]
  const widgets: Cell[] = [
    { id: 'inbox-list', x: 0, y: 0, w: 7, h: 5 },
    ...(flags.payroll ? [{ id: 'pay-tile', x: 7, y: 0, w: 5, h: 2 }] as Cell[] : []),
    ...(flags.hrm ? [{ id: 'balance-tile', x: 7, y: 2, w: 5, h: 3 }] as Cell[] : []),
    ...(flags.hrm ? [{ id: 'whos-out-strip', x: 0, y: 5, w: 6, h: 4 }] as Cell[] : []),
    ...(flags.payroll || flags.hrm ? [{ id: 'home-upcoming', x: 6, y: 5, w: 6, h: 4 }] as Cell[] : []),
    ...(flags.celebrations ? [{ id: 'celebrations-list', x: 0, y: 9, w: 6, h: 4 }] as Cell[] : []),
    ...(flags.announcements ? [{ id: 'announcements-card', x: 6, y: 9, w: 6, h: 4 }] as Cell[] : []),
    { id: 'home-ask', x: 0, y: 13, w: 12, h: 3 },
  ]
  if (persona === 'manager' || persona === 'admin') {
    widgets.push(
      { id: 'team-approvals', x: 0, y: 16, w: 7, h: 5 },
      ...(flags.hrm ? [{ id: 'team-headcount', x: 7, y: 16, w: 5, h: 2 }] as Cell[] : []),
      ...(flags.hrm ? [{ id: 'team-steps', x: 7, y: 18, w: 5, h: 3 }] as Cell[] : []),
      ...(flags.nudges ? [{ id: 'team-nudges', x: 0, y: 21, w: 12, h: 4 }] as Cell[] : []),
      ...(flags.quals ? [{ id: 'team-quals', x: 0, y: 25, w: 12, h: 4 }] as Cell[] : []),
    )
  }
  if (persona === 'admin') {
    widgets.push(
      { id: 'admin-attention', x: 0, y: 29, w: 6, h: 5 },
      { id: 'workflow-errors', x: 6, y: 29, w: 3, h: 2 },
      { id: 'admin-calendar', x: 9, y: 29, w: 3, h: 4 },
    )
  }
  return { widgets }
}

export interface PersonaInboxItem {
  id: string
  kind: string
  title: string
  subtitle: string | null
  dueAt: string | null
  href: string
  priority: string
  actions: { key: string; label: string; style: 'primary' | 'secondary' | 'danger'; needsReason: boolean }[]
}

function toPersonaItem(item: InboxItem): PersonaInboxItem {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    subtitle: item.subtitle,
    dueAt: item.dueAt,
    href: item.subjectHref,
    priority: item.priority,
    actions: item.actions.map((action) => ({ ...action })),
  }
}

export interface PersonaMetrics {
  inboxTasksTop: PersonaInboxItem[] | null
  inboxApprovalsTop: PersonaInboxItem[] | null
  inboxCount: number | null
  payTile: { nextPayDate: string | null; lastPayDate: string | null; slipHref: string | null } | null
  balances: { code: string; hours: string }[] | null
  whosOut: { name: string; range: string }[] | null
  upcoming: { label: string; date: string; href: string }[] | null
  celebrations: { name: string; detail: string }[] | null
  announcements: { title: string; body: string | null }[] | null
  teamSteps: { title: string; owner: string; due: string }[] | null
  teamNudges: { text: string; href: string }[] | null
  teamHeadcount: number | null
  teamQuals: { name: string; detail: string }[] | null
  adminAttention: { label: string; count: number; href: string }[] | null
  workflowErrors: { count: number; href: string } | null
  adminCalendar: { label: string; date: string }[] | null
}

const EMPTY_PERSONA: PersonaMetrics = {
  inboxTasksTop: null,
  inboxApprovalsTop: null,
  inboxCount: null,
  payTile: null,
  balances: null,
  whosOut: null,
  upcoming: null,
  celebrations: null,
  announcements: null,
  teamSteps: null,
  teamNudges: null,
  teamHeadcount: null,
  teamQuals: null,
  adminAttention: null,
  workflowErrors: null,
  adminCalendar: null,
}

/** Monday–Sunday window containing today (civil dates). */
function weekWindow(today: string): { start: string; end: string } {
  const noon = new Date(`${today}T12:00:00Z`).getTime()
  const dow = new Date(noon).getUTCDay()
  const monday = new Date(noon - ((dow + 6) % 7) * 86_400_000).toISOString().slice(0, 10)
  const sunday = new Date(noon + ((7 - dow) % 7) * 86_400_000).toISOString().slice(0, 10)
  return { start: monday, end: sunday }
}

export async function loadPersonaMetrics(
  authz: Authz,
  fields: ReadonlySet<keyof PersonaMetrics>,
): Promise<PersonaMetrics> {
  const out: PersonaMetrics = { ...EMPTY_PERSONA }
  if (fields.size === 0) return out
  const orgId = authz.user.orgId
  const userId = authz.user.id
  const need = (...names: (keyof PersonaMetrics)[]): boolean => names.some((name) => fields.has(name))
  const ctx = need('inboxTasksTop', 'inboxApprovalsTop', 'inboxCount') ? await inboxContext(authz) : null
  const today = await businessToday(orgId)
  const cache = new Map<string, InboxItem[]>()

  if (ctx && need('inboxTasksTop', 'inboxApprovalsTop', 'inboxCount')) {
    const [tasks, approvals] = await Promise.all([
      need('inboxTasksTop', 'inboxCount')
        ? listInbox(ctx, {
            kinds: ['hrm_process_step', 'hrm_leave_request', 'hrm_change_request', 'hrm_review', 'hrm_benefit_enrollment_window', 'hrm_qualification_alert', 'timesheet_week'],
            cache,
          })
        : Promise.resolve([] as InboxItem[]),
      need('inboxApprovalsTop', 'inboxCount')
        ? listInbox(ctx, { kinds: ['flows_approval', 'expense_report'], cache })
        : Promise.resolve([] as InboxItem[]),
    ])
    if (need('inboxTasksTop')) out.inboxTasksTop = tasks.slice(0, 5).map(toPersonaItem)
    if (need('inboxApprovalsTop')) out.inboxApprovalsTop = approvals.slice(0, 5).map(toPersonaItem)
    if (need('inboxCount')) {
      const unread = await listInbox(ctx, { kinds: ['notification'], cache })
      out.inboxCount = approvals.length + unread.length
    }
  }

  const partyId = need('payTile', 'balances', 'whosOut', 'teamSteps', 'teamHeadcount', 'celebrations')
    ? await loadApprovalPerson(db, orgId, userId).then((person) => person.partyId).catch(() => null)
    : null

  if (need('payTile') && (await isFeatureEnabled(orgId, 'payroll')) && partyId) {
    const [stub, schedule] = await Promise.all([
      db.execute<{ pay_date: string }>(sql`
        select pay_date::text as pay_date from pay_stubs
         where org_id = ${orgId} and employee_party_id = ${partyId}
         order by pay_date desc limit 1`),
      db.execute<{ anchor: string; frequency: string; offset: number }>(sql`
        select anchor_period_end::text as anchor, frequency, pay_date_offset_days as offset
          from pay_schedules
         where org_id = ${orgId} and is_active and is_default
         order by created_at limit 1`),
    ])
    const lastPayDate = stub.rows[0]?.pay_date ?? null
    let nextPayDate: string | null = null
    const row = schedule.rows[0]
    if (row) {
      const stepDays =
        row.frequency === 'weekly' ? 7 : row.frequency === 'biweekly' ? 14 : row.frequency === 'monthly' ? 0 : 15
      if (stepDays > 0) {
        let cursor = new Date(`${row.anchor}T12:00:00Z`).getTime()
        const horizon = new Date(`${today}T12:00:00Z`).getTime() + 370 * 86_400_000
        while (cursor <= new Date(`${today}T12:00:00Z`).getTime() && cursor < horizon) cursor += stepDays * 86_400_000
        if (cursor < horizon) {
          nextPayDate = new Date(cursor + (row.offset ?? 0) * 86_400_000).toISOString().slice(0, 10)
        }
      } else {
        const [year = 0, month = 0] = today.split('-').map(Number)
        const anchorDay = Number(row.anchor.slice(8, 10))
        const candidate = `${year}-${String(month).padStart(2, '0')}-${String(Math.min(anchorDay, 28)).padStart(2, '0')}`
        nextPayDate = candidate > today ? candidate : `${month === 12 ? year + 1 : year}-${String(month === 12 ? 1 : month + 1).padStart(2, '0')}-${String(Math.min(anchorDay, 28)).padStart(2, '0')}`
      }
    }
    out.payTile = lastPayDate === null && nextPayDate === null ? null : { nextPayDate, lastPayDate, slipHref: '/payroll' }
  }

  if (need('balances') && partyId && (await isFeatureEnabled(orgId, 'hrm'))) {
    const employmentIds = await findEmploymentsByParty({ orgId, actorId: userId, workerPartyId: partyId }).catch(() => [] as readonly string[])
    // Null policy (no coverage) reads as a null balance — uncovered types
    // are skipped, and a tile with no computable balance stays absent
    // rather than rendering a zero as a fact.
    const types = employmentIds.length > 0 ? await listLeaveTypes(db, orgId).catch(() => []) : []
    const balances: { code: string; hours: string }[] = []
    for (const employmentId of employmentIds.slice(0, 3)) {
      for (const type of types.filter((candidate) => candidate.isActive).slice(0, 6)) {
        const balance = await timeBalanceAsOf(db, orgId, employmentId, type.id, today).catch(() => null)
        if (!balance) continue
        if (balance.unlimited) balances.push({ code: type.code, hours: 'unlimited' })
        else if (balance.balance !== null) balances.push({ code: type.code, hours: balance.balance })
      }
    }
    out.balances = balances.length > 0 ? balances.slice(0, 3) : null
  }

  const teamIds = need('whosOut', 'teamSteps', 'teamNudges', 'teamHeadcount', 'celebrations')
    ? await teamEmploymentIds(authz, today)
    : []
  const isManager = teamIds.length > 0

  if (need('whosOut')) {
    // My team: my reports when I hold them, else my peers (my manager's
    // reports, me included) — the people whose absence affects my week.
    let scopeIds = teamIds
    if (scopeIds.length === 0 && partyId) {
      const mine = await findEmploymentsByParty({ orgId, actorId: userId, workerPartyId: partyId }).catch(() => [] as readonly string[])
      if (mine.length > 0) {
        const managers = (await db.execute<{ id: string }>(sql`
          select distinct manager_employment_id::text as id from reporting_relationships
           where org_id = ${orgId} and employment_id in (select jsonb_array_elements_text(${JSON.stringify([...mine])}::jsonb)::uuid)
             and kind = 'line' and recorded_until is null
             and effective_from <= ${today}::date and (effective_to is null or effective_to > ${today}::date)
        `)).rows.map((row) => row.id)
        scopeIds = await loadTeamEmploymentIdsForManager(db, orgId, managers, today).catch(() => [])
      }
    }
    if (scopeIds.length > 0) {
      const { start, end } = weekWindow(today)
      const rows = (await db.execute<{ name: string; starts_on: string; ends_on: string }>(sql`
        select p.display_name as name, r.starts_on::text as starts_on, r.ends_on::text as ends_on
          from hrm_leave_requests r
          join worker_employments e on e.org_id = r.org_id and e.id = r.employment_id
          join parties p on p.org_id = r.org_id and p.id = e.worker_party_id
         where r.org_id = ${orgId} and r.status = 'approved'
           and r.starts_on <= ${end}::date and r.ends_on >= ${start}::date
           and r.employment_id in (select jsonb_array_elements_text(${JSON.stringify(scopeIds)}::jsonb)::uuid)
         order by r.starts_on, p.display_name limit 10`)).rows
      out.whosOut = rows.map((row) => ({ name: row.name, range: `${row.starts_on} → ${row.ends_on}` }))
    } else {
      out.whosOut = []
    }
  }

  if (need('upcoming')) {
    const upcoming: { label: string; date: string; href: string }[] = []
    if (await isFeatureEnabled(orgId, 'payroll')) {
      const holidays = (await db.execute<{ name: string; on: string }>(sql`
        select coalesce(nullif(name, ''), jurisdiction) as name, observed_on::text as on from payroll_holidays
         where org_id = ${orgId} and observed_on >= ${today}::date and observed_on <= ${today}::date + 30
         order by observed_on limit 5`).catch(() => ({ rows: [] as { name: string; on: string }[] }))).rows
      for (const holiday of holidays) upcoming.push({ label: holiday.name, date: holiday.on, href: '/payroll' })
    }
    if (await isFeatureEnabled(orgId, 'hrm')) {
      const mine = await listMyReviews({ orgId, actorId: userId }).catch(() => null)
      if (mine) {
        for (const review of [...mine.asReviewer.filter((r) => r.status === 'pending'), ...mine.asSubject.filter((r) => r.status === 'shared')].slice(0, 3)) {
          upcoming.push({ label: 'Review due', date: today, href: `/hrm/performance?review=${review.id}` })
        }
      }
    }
    out.upcoming = upcoming.slice(0, 5)
  }

  if (need('celebrations') && (await isFeatureEnabled(orgId, 'hrmCelebrations')) && (await isFeatureEnabled(orgId, 'hrm'))) {
    const teamScope = isManager ? teamIds : null
    const rows = (await db.execute<{ name: string; service_start: string }>(sql`
      select p.display_name as name, min(v.effective_from)::text as service_start
        from worker_employments e
        join worker_employment_versions v on v.org_id = e.org_id and v.employment_id = e.id and v.recorded_until is null
        join parties p on p.org_id = e.org_id and p.id = e.worker_party_id
       where e.org_id = ${orgId}
         ${teamScope ? sql`and e.id in (select jsonb_array_elements_text(${JSON.stringify(teamScope)}::jsonb)::uuid)` : sql``}
       group by p.display_name
       having min(v.effective_from) >= ${today}::date - 30
           or to_char(min(v.effective_from)::date, 'MM-DD') in (
             select to_char(d::date, 'MM-DD') from generate_series(${today}::date - 3, ${today}::date + 3, '1 day') d)
       order by min(v.effective_from) desc limit 8`)).rows
    out.celebrations = rows.map((row) => {
      const years = Number(today.slice(0, 4)) - Number(row.service_start.slice(0, 4))
      return {
        name: row.name,
        detail: row.service_start > today ? `joins ${row.service_start}` : years > 0 ? `${years} year${years === 1 ? '' : 's'}` : `since ${row.service_start}`,
      }
    })
  }

  if (need('announcements') && (await isFeatureEnabled(orgId, 'homeAnnouncements'))) {
    const persona = isManager ? 'manager' : hasAdminPersona(authz) ? 'admin' : 'employee'
    out.announcements = (await liveHomeAnnouncements(orgId, persona, today)).map((row) => ({ title: row.title, body: row.body }))
  }

  if (need('teamSteps') && isManager) {
    const rows = (await db.execute<{ title: string; owner: string; due_on: string }>(sql`
      select s.title, wp.display_name as owner, s.due_on::text as due_on
        from hrm_process_steps s
        join hrm_processes p on p.org_id = s.org_id and p.id = s.process_id
        join worker_employments e on e.org_id = s.org_id and e.id = p.employment_id
        join parties wp on wp.org_id = s.org_id and wp.id = e.worker_party_id
       where s.org_id = ${orgId} and p.status = 'open' and s.status = 'pending' and s.due_on < ${today}::date
         and p.employment_id in (select jsonb_array_elements_text(${JSON.stringify(teamIds)}::jsonb)::uuid)
       order by s.due_on limit 8`)).rows
    out.teamSteps = rows.map((row) => ({ title: row.title, owner: row.owner, due: row.due_on }))
  }

  if (need('teamNudges') && isManager && (await isFeatureEnabled(orgId, 'hrmManagerNudges'))) {
    const nudges: { text: string; href: string }[] = []
    const overdue = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from hrm_process_steps s
        join hrm_processes p on p.org_id = s.org_id and p.id = s.process_id
       where s.org_id = ${orgId} and p.status = 'open' and s.status = 'pending' and s.due_on < ${today}::date
         and p.employment_id in (select jsonb_array_elements_text(${JSON.stringify(teamIds)}::jsonb)::uuid)`)).rows[0]?.n ?? 0
    if (overdue > 0) nudges.push({ text: `${overdue} checklist step${overdue === 1 ? '' : 's'} overdue on your team`, href: '/hrm/processes' })
    const joiners = (await db.execute<{ n: number }>(sql`
      select count(distinct e.id)::int as n from worker_employments e
        join worker_employment_versions v on v.org_id = e.org_id and v.employment_id = e.id and v.recorded_until is null
       where e.org_id = ${orgId} and v.effective_from >= ${today}::date - 30
         and e.id in (select jsonb_array_elements_text(${JSON.stringify(teamIds)}::jsonb)::uuid)`)).rows[0]?.n ?? 0
    if (joiners > 0) nudges.push({ text: `${joiners} new joiner${joiners === 1 ? '' : 's'} in the last 30 days — schedule the first 1:1`, href: '/hrm' })
    out.teamNudges = nudges
  }

  if (need('teamHeadcount') && isManager && (await isFeatureEnabled(orgId, 'hrm'))) {
    const rows = (await db.execute<{ n: number }>(sql`
      select count(distinct e.id)::int as n from worker_employments e
        join worker_employment_versions v on v.org_id = e.org_id and v.employment_id = e.id and v.recorded_until is null
       where e.org_id = ${orgId} and v.status = 'active'
         and v.effective_from <= ${today}::date and (v.effective_to is null or v.effective_to > ${today}::date)
         and e.id in (select jsonb_array_elements_text(${JSON.stringify(teamIds)}::jsonb)::uuid)`)).rows
    out.teamHeadcount = rows[0]?.n ?? 0
  }

  if (need('teamQuals')) {
    // HR-14 has not landed: the source probe finds no table and the tile
    // stays absent (the persona layout excludes it until then).
    out.teamQuals = (await qualificationSourceAvailable()) ? [] : null
  }

  if (need('adminAttention') && hasAdminPersona(authz)) {
    const attention: { label: string; count: number; href: string }[] = []
    if (can(authz, 'hrm.employment.read')) {
      const pending = await listInbox(ctx ?? await inboxContext(authz), {
        kinds: ['hrm_leave_request', 'hrm_change_request', 'hrm_process_step'],
        cache,
      }).catch(() => [] as InboxItem[])
      if (pending.length > 0) attention.push({ label: 'HRM items waiting', count: pending.length, href: '/inbox?filter=my_tasks' })
    }
    if (await isFeatureEnabled(orgId, 'payroll')) {
      const { payrollHome } = await import('@/lib/module-home/payroll')
      const home = await payrollHome(orgId, authz.allowedSubsidiaryIds ?? undefined).catch(() => null)
      const missing = home?.missingSettings.length ?? 0
      if (missing > 0) attention.push({ label: 'Payroll setup needs control accounts', count: missing, href: '/payroll' })
    }
    const unmatched = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from bank_statement_lines
       where org_id = ${orgId} and match_status = 'unmatched'`).catch(() => ({ rows: [{ n: 0 }] }))).rows[0]?.n ?? 0
    if (unmatched > 0) attention.push({ label: 'Bank lines unmatched', count: unmatched, href: '/banking/match' })
    const openClose = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from close_runs
       where org_id = ${orgId} and status not in ('closed', 'cancelled')`).catch(() => ({ rows: [{ n: 0 }] }))).rows[0]?.n ?? 0
    if (openClose > 0) attention.push({ label: 'Open close runs', count: openClose, href: '/close' })
    out.adminAttention = attention
  }

  if (need('workflowErrors') && (hasAdminPersona(authz) || can(authz, 'flows.manage'))) {
    const failed = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from flow_runs
       where org_id = ${orgId} and status = 'failed'`).catch(() => ({ rows: [{ n: 0 }] }))).rows[0]?.n ?? 0
    out.workflowErrors = { count: failed, href: '/admin/flows' }
  }

  if (need('adminCalendar') && hasAdminPersona(authz)) {
    const calendar: { label: string; date: string }[] = []
    const schedules = (await db.execute<{ name: string; at: string }>(sql`
      select d.name as name, s.next_run_at::text as at from report_schedules s
        join report_definitions d on d.org_id = s.org_id and d.id = s.definition_id
       where s.org_id = ${orgId} and s.next_run_at <= now() + interval '30 days'
       order by s.next_run_at limit 5`).catch(() => ({ rows: [] as { name: string; at: string }[] }))).rows
    for (const schedule of schedules) calendar.push({ label: schedule.name, date: schedule.at.slice(0, 10) })
    const remittances = (await db.execute<{ at: string }>(sql`
      select created_at::text as at from payment_remittances
       where org_id = ${orgId} and status = 'pending'
       order by created_at limit 5`).catch(() => ({ rows: [] as { at: string }[] }))).rows
    for (const remittance of remittances) calendar.push({ label: 'Payroll remittance pending', date: remittance.at.slice(0, 10) })
    out.adminCalendar = calendar.slice(0, 6)
  }

  return out
}

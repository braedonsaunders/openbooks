import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'
import { postProjectLaborCost } from '@openbooks/engine/src/project-recognition.ts'
import { laborCostingSettings, snapshotLaborCostRates } from '@openbooks/engine/src/labor-costing.ts'
import { applyOverheadForTime } from '@openbooks/engine/src/overhead-apply.ts'
import { snapshotTimeBillRates } from '../../../../lib/item-rates'
import { isIsoDate, loadWeek, weekStart, weekWindow } from '../_lib'

export const runtime = 'nodejs'

function bad(error: string) {
  return NextResponse.json({ error }, { status: 422 })
}

interface Body {
  employee?: string
  week?: string
}

/**
 * POST { employee, week } → approve the week: submitted entries become
 * approved, stamped with the approver and timestamp. Draft entries are left
 * alone (submit them first) so approval is an explicit two-step gate.
 */
export async function POST(req: Request) {
  const gate = await guardPermission('time.approve')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const orgId = user.orgId

  const body = (await req.json()) as Body
  if (!body.employee || !isUuid(body.employee)) return bad('Invalid employee')
  if (!body.week || !isIsoDate(body.week)) return bad('Invalid week')
  const week = weekStart(body.week)
  const days = weekWindow(week)

  const approved = (await db.execute(sql`
    update time_entries
       set status = 'approved',
           approved_by = ${user.id},
           approved_at = now(),
           updated_at = now(),
           updated_by = ${user.id}
     where org_id = ${orgId}
       and employee_party_id = ${body.employee}
       and worked_on >= ${days[0]} and worked_on <= ${days[6]}
       and status = 'submitted'
     returning id
  `)) as unknown as { rows: { id: string }[] }

  // Snapshot standard cost rates (wage × time-type multiplier + estimate
  // components) onto entries that don't carry one, then post labor cost to
  // project WIP (DR labor WIP / CR labor clearing). Both are inert until
  // configured (rates entered + labor accounts mapped + mode 'post') and
  // non-blocking so a GL hiccup never strands the approval — the entries stay
  // re-postable.
  const ids = approved.rows.map((r) => r.id)
  if (ids.length > 0) {
    try {
      const settings = await laborCostingSettings(orgId)
      await snapshotLaborCostRates(orgId, ids)
      await snapshotTimeBillRates(orgId, ids)
      if (settings.mode === 'post') await postProjectLaborCost(orgId, user.id, ids)
      // Overhead rides with the hours (net-zero pair) — inert unless that
      // application mode is on; never waits for payroll actuals.
      await applyOverheadForTime(orgId, user.id, ids)
    } catch (e) {
      console.error('[timesheets/approve] labor cost snapshot/posting failed:', (e as Error).message)
    }
  }

  const payload = await loadWeek(orgId, body.employee, week)
  return NextResponse.json(payload)
}

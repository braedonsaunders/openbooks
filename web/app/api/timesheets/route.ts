import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { normalizeMoney } from '@openbooks/engine/src/money.ts'
import { guardFeaturePermission } from '../../../lib/feature-gates'
import { isFeatureEnabled } from '../../../lib/features'
import { isUuid } from '../../../lib/list-params'
import { loadFieldDefs, validateCustomValues } from '../../../lib/custom-fields'
import { initialEntryStatus, loadTimePolicy } from '../../../lib/time-policy'
import { canonicalDecimal, compareDecimal } from '../../../lib/exact-decimal'
import { isIsoDate, loadWeek, pinTimesheetEmployee, pinTimesheetLineRefs, weekStart, weekWindow } from './_lib'

export const runtime = 'nodejs'

const INVENTORY_ITEM_KINDS = new Set(['inventory', 'assembly', 'kit'])

function bad(error: string) {
  return NextResponse.json({ error }, { status: 422 })
}

interface SaveRow {
  projectId?: string | null
  itemId?: string | null
  timeTypeId?: string | null
  departmentId?: string | null
  isBillable?: boolean
  memo?: string | null
  hours?: (string | number | null)[]
  custom?: Record<string, unknown>
}
interface SaveBody {
  employee?: string
  week?: string
  rows?: SaveRow[]
}

function uuidOrNull(v: unknown): string | null | 'invalid' {
  if (v == null || v === '') return null
  if (typeof v !== 'string' || !isUuid(v)) return 'invalid'
  return v
}

/** Parse an hours cell → non-negative money string, or null (blank/zero). */
function hoursOrNull(v: unknown): string | null | 'invalid' {
  if (v == null || v === '') return null
  const exact = canonicalDecimal(v, 4)
  if (exact === null) return 'invalid'
  let hours: string
  try {
    hours = normalizeMoney(exact)
  } catch {
    return 'invalid'
  }
  if (compareDecimal(hours, '0') < 0) return 'invalid'
  if (compareDecimal(hours, '0') === 0) return null
  return hours
}

/** GET ?employee=&week= → the week's grid rows + status. */
export async function GET(req: Request) {
  const gate = await guardFeaturePermission('time.read', 'timeTracking')
  if (gate instanceof NextResponse) return gate
  const orgId = gate.user.orgId

  const url = new URL(req.url)
  const employee = url.searchParams.get('employee')
  const weekParam = url.searchParams.get('week')
  if (!employee || !isUuid(employee)) return bad('Invalid employee')
  if (!weekParam || !isIsoDate(weekParam)) return bad('Invalid week')

  const ownedEmployee = await pinTimesheetEmployee(orgId, employee)
  if (!ownedEmployee) return bad('Employee not found')

  const payload = await loadWeek(orgId, ownedEmployee, weekStart(weekParam))
  return NextResponse.json(payload)
}

/**
 * Save the week: replace this employee+week's editable time_entries from the
 * submitted grid. For each grid row × day with hours > 0 we upsert one entry;
 * entries in the week no longer represented are deleted. Only draft/rejected
 * entries are ever touched — approved and submitted entries are left intact so
 * a save never silently overwrites an approval (or an in-flight submission).
 */
async function save(req: Request) {
  const gate = await guardFeaturePermission('time.manage', 'timeTracking')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const orgId = user.orgId

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as SaveBody
  const employee = uuidOrNull(body.employee)
  if (employee === 'invalid' || employee === null) return bad('Invalid employee')
  if (!body.week || !isIsoDate(body.week)) return bad('Invalid week')
  const week = weekStart(body.week)
  const days = weekWindow(week)
  if (!Array.isArray(body.rows)) return bad('Rows must be a list')

  const ownedEmployee = await pinTimesheetEmployee(orgId, employee)
  if (!ownedEmployee) return bad('Employee not found')

  // Normalize each grid row × day into a flat list of entries to persist.
  interface Persist {
    workedOn: string
    hours: string
    projectId: string | null
    itemId: string | null
    timeTypeId: string | null
    departmentId: string | null
    isBillable: boolean
    memo: string | null
    custom: Record<string, unknown>
  }
  // Org-defined line fields live on time_entries.custom; validate + strip
  // unknown keys exactly as every other record does.
  const lineDefs = await loadFieldDefs('time_entries')
  // When the org does not require approval, saved hours are usable at once
  // rather than sitting in a draft nobody will ever submit.
  const policy = await loadTimePolicy(orgId)
  const newStatus = initialEntryStatus(policy)
  const toPersist: Persist[] = []
  for (const r of body.rows) {
    const projectId = uuidOrNull(r.projectId)
    if (projectId === 'invalid') return bad('Invalid project')
    const itemId = uuidOrNull(r.itemId)
    if (itemId === 'invalid') return bad('Invalid item')
    const timeTypeId = uuidOrNull(r.timeTypeId)
    if (timeTypeId === 'invalid') return bad('Invalid time type')
    const departmentId = uuidOrNull(r.departmentId)
    if (departmentId === 'invalid') return bad('Invalid department')
    const memo = typeof r.memo === 'string' && r.memo.trim() !== '' ? r.memo.trim() : null
    const isBillable = r.isBillable === true
    const validated = validateCustomValues(lineDefs, r.custom)
    if (!validated.ok) return bad(Object.values(validated.errors)[0] ?? 'Invalid custom field')
    const custom = validated.cleaned
    const cells = Array.isArray(r.hours) ? r.hours : []
    let ownedRefs: Awaited<ReturnType<typeof pinTimesheetLineRefs>> | undefined

    for (let i = 0; i < 7; i++) {
      const h = hoursOrNull(cells[i])
      if (h === 'invalid') return bad('Hours must be a non-negative number')
      if (h === null) continue
      // A row that carries hours must at least name a project (the job).
      if (projectId === null) return bad('Each line with hours needs a project')
      if (ownedRefs === undefined) {
        ownedRefs = await pinTimesheetLineRefs(orgId, {
          projectId,
          itemId,
          timeTypeId,
          departmentId,
        })
      }
      if (!ownedRefs || ownedRefs.projectId == null) {
        return bad('Invalid project, item, time type, or department')
      }
      toPersist.push({
        workedOn: days[i],
        hours: h,
        projectId: ownedRefs.projectId,
        itemId: ownedRefs.itemId,
        timeTypeId: ownedRefs.timeTypeId,
        departmentId: ownedRefs.departmentId,
        isBillable,
        memo,
        custom,
      })
    }
  }

  // Stored time entries stay. Turning Inventory off must 404 a write that
  // would persist a new inventory / assembly / kit item. Amendments that only
  // reverse an existing locked row copy the original item and are not refused.
  if (!(await isFeatureEnabled(orgId, 'inventory'))) {
    const stored = (await db.execute<{ item_id: string }>(sql`
      select item_id from time_entries
       where org_id = ${orgId}
         and employee_party_id = ${ownedEmployee}
         and worked_on >= ${days[0]} and worked_on <= ${days[6]}
         and item_id is not null`))
    const storedIds = new Set(stored.rows.map((row) => row.item_id))
    for (const p of toPersist) {
      if (!p.itemId || storedIds.has(p.itemId)) continue
      const item = (await db.execute<{ kind: string }>(sql`
        select kind from items where id = ${p.itemId} and org_id = ${orgId}`))
      if (item.rows[0] && INVENTORY_ITEM_KINDS.has(item.rows[0].kind)) {
        return NextResponse.json({ error: 'not found' }, { status: 404 })
      }
    }
  }
  // Stored time entries stay. Turning Equipment off must 404 a write that
  // would persist a new equipment_charge item. Amendments that only reverse
  // an existing locked row copy the original item and are not refused.
  if (!(await isFeatureEnabled(orgId, 'equipment'))) {
    const stored = (await db.execute<{ item_id: string }>(sql`
      select item_id from time_entries
       where org_id = ${orgId}
         and employee_party_id = ${ownedEmployee}
         and worked_on >= ${days[0]} and worked_on <= ${days[6]}
         and item_id is not null`))
    const storedIds = new Set(stored.rows.map((row) => row.item_id))
    for (const p of toPersist) {
      if (!p.itemId || storedIds.has(p.itemId)) continue
      const item = (await db.execute<{ kind: string }>(sql`
        select kind from items where id = ${p.itemId} and org_id = ${orgId}`))
      if (item.rows[0] && item.rows[0].kind === 'equipment_charge') {
        return NextResponse.json({ error: 'not found' }, { status: 404 })
      }
    }
  }

  // Replace-in-place, but only over editable (draft/rejected) entries. We wipe
  // this employee+week's draft/rejected rows, then re-insert from the grid.
  // Approved/submitted entries are untouched — the grid already reflected them
  // read-only when the week wasn't a draft.
  await db.transaction(async (tx) => {
    // When approval is not required, saved entries land already approved, so
    // the replaceable set has to include those too — otherwise every save would
    // insert a second copy of the week's hours alongside the first. Entries any
    // downstream document has consumed stay put regardless: they are evidence
    // for an invoice, pay run or ledger entry that already exists.
    await tx.execute(sql`
      delete from time_entries
       where org_id = ${orgId}
         and employee_party_id = ${ownedEmployee}
         and worked_on >= ${days[0]} and worked_on <= ${days[6]}
         and amends_entry_id is null
         and (
           status in ('draft', 'rejected')
           or (${!policy.requireApproval} and status = 'approved'
               and invoiced_by_line_id is null and payroll_batch_ref is null
               and cost_journal_entry_id is null and overhead_journal_entry_id is null
               and field_ticket_id is null
               and billing_status = 'unbilled')
         )
    `)
    for (const p of toPersist) {
      await tx.execute(sql`
        insert into time_entries
          (org_id, employee_party_id, worked_on, hours, time_type_id, item_id,
           project_id, department_id, memo, is_billable, status, custom,
           created_by, updated_by)
        values
          (${orgId}, ${ownedEmployee}, ${p.workedOn}, ${p.hours}, ${p.timeTypeId},
           ${p.itemId}, ${p.projectId}, ${p.departmentId}, ${p.memo},
           ${p.isBillable}, ${newStatus}, ${JSON.stringify(p.custom)}::jsonb,
           ${user.id}, ${user.id})
      `)
    }
  })

  const payload = await loadWeek(orgId, ownedEmployee, week)
  return NextResponse.json(payload)
}

export const PUT = save
export const POST = save

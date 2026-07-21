import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'
import { loadFieldDefs, validateCustomValues } from '../../../../lib/custom-fields'
import { loadProject } from '../_lib'

export const runtime = 'nodejs'

const STATUSES = ['quoted', 'awarded', 'active', 'substantially_complete', 'closed', 'cancelled'] as const
const BILLING_METHODS = ['time_and_materials', 'fixed_price', 'cost_plus'] as const
const LABOR_RATE_POLICIES = ['work_date', 'locked', 'scheduled_escalation', 'manual_reprice'] as const
const TASK_STATUSES = ['open', 'complete', 'cancelled'] as const
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function bad(error: string, fieldErrors?: Record<string, string>) {
  return NextResponse.json({ error, ...(fieldErrors ? { fieldErrors } : {}) }, { status: 422 })
}

/** Trimmed string or null ('' and non-strings collapse to null). */
function strOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  return s === '' ? null : s
}

function uuidOrNull(v: unknown): string | null | 'invalid' {
  const s = strOrNull(v)
  if (s === null) return null
  return isUuid(s) ? s : 'invalid'
}

/** Parse a money-ish string → 4dp numeric string, null, or 'invalid'. */
function moneyOrNull(v: unknown): string | null | 'invalid' {
  const s = strOrNull(v)
  if (s === null) return null
  const n = Number(s)
  if (Number.isNaN(n)) return 'invalid'
  return n.toFixed(4)
}

interface TaskInput {
  id?: string | null
  code?: string | null
  name?: string
  status?: string
  estimatedHours?: string | null
  estimatedCost?: string | null
}

interface PatchBody {
  name?: string
  code?: string | null
  customerId?: string | null
  foremanId?: string | null
  managerId?: string | null
  status?: string
  billingMethod?: string | null
  laborRateBookId?: string | null
  laborRatePolicy?: string | null
  projectTypeId?: string | null
  invoicingPreference?: Record<string, unknown> | null
  customerPoNumber?: string | null
  startsOn?: string | null
  endsOn?: string | null
  notes?: string | null
  contractValue?: string | null
  custom?: Record<string, unknown>
  subsidiaryId?: string | null
  subsidiaryIncludeChildren?: boolean
  isActive?: boolean
  tasks?: TaskInput[]
}

async function partyExists(id: string, orgId: string): Promise<boolean> {
  const r = (await db.execute(
    sql`select 1 from parties where id = ${id} and org_id = ${orgId}`,
  )) as unknown as { rows: unknown[] }
  return !!r.rows[0]
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('projects.read')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const payload = await loadProject(id, gate.user.orgId)
  if (!payload) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json(payload)
}

/**
 * Autosave for the project flyout: header fields, the party links, the contract
 * value (merged into custom), the WBS task list (replace semantics — rows not
 * present are deleted, provided rows are inserted/updated), and the explicit
 * activate/deactivate action. Only provided fields are touched; a real name is
 * required to activate.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('projects.manage')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const existing = (await db.execute(sql`
    select name, is_active, custom from projects where id = ${id} and org_id = ${user.orgId}
  `)) as unknown as { rows: { name: string; is_active: boolean; custom: Record<string, unknown> | null }[] }
  if (!existing.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const body = (await req.json()) as PatchBody

  // -- enums ---------------------------------------------------------------
  if (body.status !== undefined && !STATUSES.includes(body.status as (typeof STATUSES)[number])) {
    return bad('Invalid status')
  }
  if (
    body.billingMethod !== undefined &&
    body.billingMethod !== null &&
    !BILLING_METHODS.includes(body.billingMethod as (typeof BILLING_METHODS)[number])
  ) {
    return bad('Invalid billing method')
  }
  if (body.laborRatePolicy !== undefined && body.laborRatePolicy !== null && !LABOR_RATE_POLICIES.includes(body.laborRatePolicy as (typeof LABOR_RATE_POLICIES)[number])) {
    return bad('Invalid labor rate policy')
  }

  // -- name / activation ---------------------------------------------------
  const name = body.name !== undefined ? body.name.trim() : undefined
  const willBeActive = body.isActive ?? existing.rows[0].is_active
  const effectiveName = name ?? existing.rows[0].name.trim()
  if (willBeActive && (!effectiveName || effectiveName === 'New project')) {
    return bad(
      body.isActive === true ? 'Give the project a real name before activating it' : 'An active project needs a name',
    )
  }

  // -- party references (must exist & belong to org) -----------------------
  let customerId: string | null | undefined
  if (body.customerId !== undefined) {
    const v = uuidOrNull(body.customerId)
    if (v === 'invalid') return bad('Invalid customer')
    if (v !== null && !(await partyExists(v, user.orgId))) return bad('Customer not found')
    customerId = v
  }
  let foremanId: string | null | undefined
  if (body.foremanId !== undefined) {
    const v = uuidOrNull(body.foremanId)
    if (v === 'invalid') return bad('Invalid foreman')
    if (v !== null && !(await partyExists(v, user.orgId))) return bad('Foreman not found')
    foremanId = v
  }
  let managerId: string | null | undefined
  if (body.managerId !== undefined) {
    const v = uuidOrNull(body.managerId)
    if (v === 'invalid') return bad('Invalid manager')
    if (v !== null && !(await partyExists(v, user.orgId))) return bad('Manager not found')
    managerId = v
  }

  let subsidiaryId: string | null | undefined
  if (body.subsidiaryId !== undefined) {
    const value = uuidOrNull(body.subsidiaryId)
    if (value === 'invalid') return bad('Invalid subsidiary')
    if (value) {
      const subsidiary = (await db.execute(sql`
        select 1 from subsidiaries
         where id = ${value} and org_id = ${user.orgId} and is_active and not is_elimination`)) as any
      if (!subsidiary.rows.length) return bad('Subsidiary not found')
    }
    subsidiaryId = value
  }

  let laborRateBookId: string | null | undefined
  if (body.laborRateBookId !== undefined) {
    const value = uuidOrNull(body.laborRateBookId)
    if (value === 'invalid') return bad('Invalid labor rate book')
    if (value) {
      const book = (await db.execute(sql`
        select 1 from item_rate_books where id = ${value} and org_id = ${user.orgId} and is_active`)) as any
      if (!book.rows.length) return bad('Labor rate book not found')
    }
    laborRateBookId = value
  }

  // -- dates ---------------------------------------------------------------
  let startsOn: string | null | undefined
  if (body.startsOn !== undefined) {
    const s = strOrNull(body.startsOn)
    if (s !== null && !DATE_RE.test(s)) return bad('Invalid start date')
    startsOn = s
  }
  let endsOn: string | null | undefined
  if (body.endsOn !== undefined) {
    const s = strOrNull(body.endsOn)
    if (s !== null && !DATE_RE.test(s)) return bad('Invalid end date')
    endsOn = s
  }

  // -- custom jsonb: contract value + admin-defined custom fields -----------
  // Both live in the same `custom` blob, so build one merged object: start
  // from the existing custom, apply the contractValue delta, then overlay the
  // validated custom-field values (unknown keys already stripped by validate).
  // Native project-level invoicing override (a real column, not custom jsonb).
  let invoicingPref: Record<string, unknown> | null | undefined
  if (body.invoicingPreference !== undefined) {
    const p = body.invoicingPreference
    invoicingPref = p == null || (typeof p === 'object' && Object.values(p).every((v) => v == null)) ? null : p
  }

  let mergedCustom: Record<string, unknown> | undefined
  if (body.contractValue !== undefined || body.custom !== undefined) {
    const base = { ...(existing.rows[0].custom ?? {}) }
    if (body.contractValue !== undefined) {
      const v = moneyOrNull(body.contractValue)
      if (v === 'invalid') return bad('Contract value must be a number')
      if (v === null) delete base.contractValue
      else base.contractValue = v
    }
    if (body.custom !== undefined) {
      const defs = await loadFieldDefs('projects')
      const result = validateCustomValues(defs, body.custom)
      if (!result.ok) return bad(Object.values(result.errors)[0]!, result.errors)
      // Rebuild the custom-field portion from the validated payload (the drawer
      // sends the full set): drop every def key first so cleared fields vanish,
      // then overlay cleaned. Non-def keys (e.g. contractValue) are preserved.
      for (const d of defs) delete base[d.key]
      Object.assign(base, result.cleaned)
    }
    mergedCustom = base
  }

  // -- validate tasks up front (before we touch anything) ------------------
  let tasks: { id: string | null; code: string | null; name: string; status: string; estimatedHours: string | null; estimatedCost: string | null }[] | undefined
  if (body.tasks !== undefined) {
    if (!Array.isArray(body.tasks)) return bad('Tasks must be a list')
    tasks = []
    for (const t of body.tasks) {
      const tName = typeof t.name === 'string' ? t.name.trim() : ''
      if (!tName) continue // skip blank rows silently
      const tStatus =
        t.status && TASK_STATUSES.includes(t.status as (typeof TASK_STATUSES)[number]) ? t.status : 'open'
      const eh = moneyOrNull(t.estimatedHours)
      if (eh === 'invalid') return bad('Estimated hours must be a number')
      const ec = moneyOrNull(t.estimatedCost)
      if (ec === 'invalid') return bad('Estimated cost must be a number')
      const tid = t.id != null && isUuid(String(t.id)) ? String(t.id) : null
      tasks.push({
        id: tid,
        code: strOrNull(t.code),
        name: tName,
        status: tStatus,
        estimatedHours: eh,
        estimatedCost: ec,
      })
    }
  }

  // Project type: assigning one also derives the coarse billing_method so the
  // back-compat classifier stays consistent with the type.
  let projectTypeId: string | null | undefined
  let derivedBilling: string | null | undefined
  if (body.projectTypeId !== undefined) {
    const v = uuidOrNull(body.projectTypeId)
    if (v === 'invalid') return bad('Invalid project type')
    projectTypeId = v
    if (v) {
      const pt = (await db.execute(sql`select billing_method from project_types where id = ${v} and org_id = ${user.orgId}`)) as unknown as { rows: { billing_method: string | null }[] }
      if (pt.rows.length === 0) return bad('Unknown project type')
      derivedBilling = pt.rows[0].billing_method ?? undefined
    }
  }

  await db.execute(sql`
    update projects set
      name = ${name !== undefined ? name : sql`name`},
      project_type_id = ${projectTypeId !== undefined ? projectTypeId : sql`project_type_id`},
      invoicing_preference = ${invoicingPref !== undefined ? (invoicingPref === null ? sql`null` : sql`${JSON.stringify(invoicingPref)}::jsonb`) : sql`invoicing_preference`},
      code = ${body.code !== undefined ? strOrNull(body.code) : sql`code`},
      customer_id = ${customerId !== undefined ? customerId : sql`customer_id`},
      foreman_id = ${foremanId !== undefined ? foremanId : sql`foreman_id`},
      manager_id = ${managerId !== undefined ? managerId : sql`manager_id`},
      subsidiary_id = ${subsidiaryId !== undefined ? subsidiaryId : sql`subsidiary_id`},
      subsidiary_include_children = ${body.subsidiaryIncludeChildren !== undefined ? body.subsidiaryIncludeChildren : sql`subsidiary_include_children`},
      status = coalesce(${body.status ?? null}, status),
      billing_method = ${body.billingMethod !== undefined ? body.billingMethod : (derivedBilling !== undefined ? derivedBilling : sql`billing_method`)},
      labor_rate_locked_version_id = case
        when (${laborRateBookId !== undefined} and labor_rate_book_id is distinct from ${laborRateBookId ?? null})
          or (${body.laborRatePolicy !== undefined} and labor_rate_policy is distinct from ${body.laborRatePolicy ?? null})
          or ${body.laborRatePolicy === 'work_date' || body.laborRatePolicy === 'scheduled_escalation'}
        then null else labor_rate_locked_version_id end,
      labor_rate_lock_date = case
        when (${laborRateBookId !== undefined} and labor_rate_book_id is distinct from ${laborRateBookId ?? null})
          or (${body.laborRatePolicy !== undefined} and labor_rate_policy is distinct from ${body.laborRatePolicy ?? null})
          or ${body.laborRatePolicy === 'work_date' || body.laborRatePolicy === 'scheduled_escalation'}
        then null else labor_rate_lock_date end,
      labor_rate_book_id = ${laborRateBookId !== undefined ? laborRateBookId : sql`labor_rate_book_id`},
      labor_rate_policy = ${body.laborRatePolicy !== undefined ? body.laborRatePolicy : sql`labor_rate_policy`},
      customer_po_number = ${body.customerPoNumber !== undefined ? strOrNull(body.customerPoNumber) : sql`customer_po_number`},
      starts_on = ${startsOn !== undefined ? startsOn : sql`starts_on`},
      ends_on = ${endsOn !== undefined ? endsOn : sql`ends_on`},
      notes = ${body.notes !== undefined ? strOrNull(body.notes) : sql`notes`},
      is_active = ${body.isActive !== undefined ? body.isActive : sql`is_active`},
      custom = ${mergedCustom !== undefined ? sql`${JSON.stringify(mergedCustom)}::jsonb` : sql`custom`},
      updated_at = now(), updated_by = ${user.id}
    where id = ${id}
  `)

  // -- WBS tasks: replace-in-place -----------------------------------------
  if (tasks !== undefined) {
    const keepIds = tasks.map((t) => t.id).filter((v): v is string => v !== null)
    // delete rows the client dropped
    if (keepIds.length > 0) {
      await db.execute(sql`
        delete from project_tasks
         where project_id = ${id} and org_id = ${user.orgId}
           and id not in (${sql.join(keepIds.map((k) => sql`${k}`), sql`, `)})
      `)
    } else {
      await db.execute(sql`delete from project_tasks where project_id = ${id} and org_id = ${user.orgId}`)
    }
    // upsert provided rows
    for (const t of tasks) {
      if (t.id) {
        await db.execute(sql`
          update project_tasks set
            code = ${t.code},
            name = ${t.name},
            status = ${t.status},
            estimated_hours = ${t.estimatedHours},
            estimated_cost = ${t.estimatedCost},
            updated_at = now(), updated_by = ${user.id}
          where id = ${t.id} and project_id = ${id} and org_id = ${user.orgId}
        `)
      } else {
        await db.execute(sql`
          insert into project_tasks
            (org_id, project_id, code, name, status, estimated_hours, estimated_cost, created_by, updated_by)
          values
            (${user.orgId}, ${id}, ${t.code}, ${t.name}, ${t.status}, ${t.estimatedHours}, ${t.estimatedCost}, ${user.id}, ${user.id})
        `)
      }
    }
  }

  const payload = await loadProject(id, user.orgId)
  return NextResponse.json(payload)
}

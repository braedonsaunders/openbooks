import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'
import { loadFieldDefs, validateCustomValues } from '../../../../lib/custom-fields'
import { loadProject } from '../_lib'
import { normalizeMoney } from '@openbooks/engine/src/money.ts'
import { guardProjectsFeature } from '../../../../lib/projects-gate'

export const runtime = 'nodejs'

const STATUSES = ['quoted', 'awarded', 'active', 'substantially_complete', 'closed', 'cancelled'] as const
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
  try {
    return normalizeMoney(s)
  } catch {
    return 'invalid'
  }
}

interface PatchBody {
  name?: string
  code?: string | null
  customerId?: string | null
  foremanId?: string | null
  managerId?: string | null
  status?: string
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
  tasks?: unknown
}

async function partyExists(id: string, orgId: string): Promise<boolean> {
  const r = (await db.execute(
    sql`select 1 from parties where id = ${id} and org_id = ${orgId}`,
  ))
  return !!r.rows[0]
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('projects.read')
  if (gate instanceof NextResponse) return gate
  const feature = await guardProjectsFeature(gate.user.orgId)
  if (feature) return feature
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const payload = await loadProject(id, gate.user.orgId)
  if (!payload) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json(payload)
}

/**
 * Autosave for the project flyout: header fields, the party links, the contract
 * value, and the explicit activate/deactivate action. WBS tasks have their own
 * task-scoped, audited and concurrency-controlled endpoints; accepting them
 * here would create a second mutation path with unsafe replace semantics.
 * Only provided fields are touched; a real name is required to activate.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('projects.manage')
  if (gate instanceof NextResponse) return gate
  const feature = await guardProjectsFeature(gate.user.orgId)
  if (feature) return feature
  const user = gate.user
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const existing = (await db.execute<{ name: string; is_active: boolean; custom: Record<string, unknown> | null }>(sql`
    select name, is_active, custom from projects where id = ${id} and org_id = ${user.orgId}
  `))
  if (!existing.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const body = (await req.json()) as PatchBody
  if (body.tasks !== undefined) {
    return bad('Work breakdown tasks must be changed through the project task endpoint')
  }

  // -- enums ---------------------------------------------------------------
  if (body.status !== undefined && !STATUSES.includes(body.status as (typeof STATUSES)[number])) {
    return bad('Invalid status')
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

  // -- custom jsonb: admin-defined custom fields only -----------------------
  // Native project-level invoicing override (a real column, not custom jsonb).
  let invoicingPref: Record<string, unknown> | null | undefined
  if (body.invoicingPreference !== undefined) {
    const p = body.invoicingPreference
    invoicingPref = p == null || (typeof p === 'object' && Object.values(p).every((v) => v == null)) ? null : p
  }

  let mergedCustom: Record<string, unknown> | undefined
  if (body.custom !== undefined) {
    const base = { ...(existing.rows[0].custom ?? {}) }
    const defs = await loadFieldDefs('projects')
    const result = validateCustomValues(defs, body.custom)
    if (!result.ok) return bad(Object.values(result.errors)[0]!, result.errors)
    for (const d of defs) delete base[d.key]
    Object.assign(base, result.cleaned)
    mergedCustom = base
  }

  const contractValue = body.contractValue === undefined ? undefined : moneyOrNull(body.contractValue)
  if (contractValue === 'invalid') return bad('Contract value must be a number')

  // Project type governs the billing classifier (its own billing_method column);
  // the project only stores the type reference.
  let projectTypeId: string | null | undefined
  if (body.projectTypeId !== undefined) {
    const v = uuidOrNull(body.projectTypeId)
    if (v === 'invalid') return bad('Invalid project type')
    projectTypeId = v
    if (v) {
      const pt = (await db.execute(sql`select 1 from project_types where id = ${v} and org_id = ${user.orgId} and is_active`))
      if (pt.rows.length === 0) return bad('Unknown project type')
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
      customer_po_number = ${body.customerPoNumber !== undefined ? strOrNull(body.customerPoNumber) : sql`customer_po_number`},
      contract_value = ${contractValue !== undefined ? contractValue : sql`contract_value`},
      starts_on = ${startsOn !== undefined ? startsOn : sql`starts_on`},
      ends_on = ${endsOn !== undefined ? endsOn : sql`ends_on`},
      notes = ${body.notes !== undefined ? strOrNull(body.notes) : sql`notes`},
      is_active = ${body.isActive !== undefined ? body.isActive : sql`is_active`},
      custom = ${mergedCustom !== undefined ? sql`${JSON.stringify(mergedCustom)}::jsonb` : sql`custom`},
      updated_at = now(), updated_by = ${user.id}
    where id = ${id}
  `)

  const payload = await loadProject(id, user.orgId)
  return NextResponse.json(payload)
}

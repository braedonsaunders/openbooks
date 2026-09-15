import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db, withOrgTransaction } from '@openbooks/engine/src/db.ts'
import { guardPermission, guardSubsidiaryScope, subsidiariesInScope } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'
import { loadFieldDefs, validateCustomValues } from '../../../../lib/custom-fields'
import { loadProject } from '../_lib'
import { normalizeMoney } from '@openbooks/engine/src/money.ts'
import { canonicalDecimal } from '../../../../lib/exact-decimal'
import { guardProjectsFeature } from '../../../../lib/projects-gate'
import { acquireFeatureGateLock, isFeatureEnabled } from '../../../../lib/features'

export const runtime = 'nodejs'

const nameBodySchema = z.looseObject({
  name: z.string().optional(),
})

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

/** Exact numeric(19,4) money string, null, or 'invalid'. */
function moneyOrNull(v: unknown): string | null | 'invalid' {
  if (v === null || v === undefined || v === '') return null
  const exact = canonicalDecimal(v, 4)
  if (exact === null) return 'invalid'
  try {
    return normalizeMoney(exact)
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
  const denied = guardSubsidiaryScope(gate, payload.project.subsidiary_id as string | null | undefined)
  if (denied) return denied
  return NextResponse.json(payload)
}

/**
 * Autosave for the project flyout: header fields, the party links, the contract
 * value, and the explicit activate/deactivate action. WBS tasks have their own
 * task-scoped, audited and concurrency-controlled endpoints; accepting them
 * here would create a second mutation path with unsafe replace semantics.
 * Only provided fields are touched; a real name is required to activate.
 *
 * The write runs under the org's feature-gate fence with the `projects` gate
 * re-checked inside the same transaction: the entry guard above read the gate
 * outside any transaction, so a concurrent feature disable could otherwise
 * commit between that read and this write and strand an active project under a
 * disabled feature. The fence is the same one the disable path holds while it
 * re-evaluates its blockers, so exactly one side wins.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('projects.manage')
  if (gate instanceof NextResponse) return gate
  const feature = await guardProjectsFeature(gate.user.orgId)
  if (feature) return feature
  const user = gate.user
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const existing = (await db.execute<{
    name: string
    is_active: boolean
    custom: Record<string, unknown> | null
    subsidiary_id: string | null
  }>(sql`
    select name, is_active, custom, subsidiary_id
      from projects where id = ${id} and org_id = ${user.orgId}
  `))
  if (!existing.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const existingDenied = guardSubsidiaryScope(gate, existing.rows[0].subsidiary_id)
  if (existingDenied) return existingDenied

  const parsedBody = await parseJsonBody(req, nameBodySchema);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as PatchBody
  if (body.tasks !== undefined) {
    return bad('Work breakdown tasks must be changed through the project task endpoint')
  }

  // -- enums ---------------------------------------------------------------
  if (body.status !== undefined && !STATUSES.includes(body.status as (typeof STATUSES)[number])) {
    return bad('Invalid status')
  }

  // -- name / activation ---------------------------------------------------
  if (body.name !== undefined && typeof body.name !== 'string') {
    return bad('Project name must be a string')
  }
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
    if (!subsidiariesInScope(gate, [value])) return bad('Subsidiary not found')
    if (value) {
      const subsidiary = ((await db.execute(sql`
        select 1 from subsidiaries
         where id = ${value} and org_id = ${user.orgId} and is_active and not is_elimination`)))
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
    // PATCH custom values are partial: validate the effective bag so an
    // omitted required field can be satisfied by its stored value.
    const result = validateCustomValues(defs, { ...base, ...body.custom })
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

  let featureRefused = false
  let scopeRefused = false
  await withOrgTransaction(user.orgId, async () => {
    // Serialize against feature toggles, then re-ask the gate the entry guard
    // already asked: its answer may be stale by the time this write lands.
    await acquireFeatureGateLock(user.orgId)
    if (!(await isFeatureEnabled(user.orgId, 'projects'))) {
      featureRefused = true
      return
    }
    const locked = (await db.execute<{
      name: string; code: string | null; customer_id: string | null; foreman_id: string | null;
      manager_id: string | null; subsidiary_id: string | null; subsidiary_include_children: boolean | null;
      status: string; customer_po_number: string | null; contract_value: string | null;
      starts_on: string | null; ends_on: string | null; notes: string | null; is_active: boolean;
      project_type_id: string | null; invoicing_preference: unknown; custom: unknown;
    }>(sql`
      select name, code, customer_id, foreman_id, manager_id, subsidiary_id,
             subsidiary_include_children, status, customer_po_number,
             contract_value::text as contract_value,
             starts_on::text as starts_on, ends_on::text as ends_on,
             notes, is_active, project_type_id, invoicing_preference, custom
        from projects
       where id = ${id} and org_id = ${user.orgId}
       for update
    `))
    if (!locked.rows[0] || guardSubsidiaryScope(gate, locked.rows[0].subsidiary_id)) {
      scopeRefused = true
      return
    }
    const before = locked.rows[0]
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
    where id = ${id} and org_id = ${user.orgId}
  `)
    // Header edits move billing caps, ownership, and legal-entity scope, so
    // they carry the same audit row every other material project write does.
    const changedFields: Array<[string, unknown, unknown]> = []
    if (name !== undefined) changedFields.push(['name', before.name, name])
    if (projectTypeId !== undefined) changedFields.push(['project_type_id', before.project_type_id, projectTypeId])
    if (invoicingPref !== undefined) changedFields.push(['invoicing_preference', before.invoicing_preference, invoicingPref])
    if (body.code !== undefined) changedFields.push(['code', before.code, strOrNull(body.code)])
    if (customerId !== undefined) changedFields.push(['customer_id', before.customer_id, customerId])
    if (foremanId !== undefined) changedFields.push(['foreman_id', before.foreman_id, foremanId])
    if (managerId !== undefined) changedFields.push(['manager_id', before.manager_id, managerId])
    if (subsidiaryId !== undefined) changedFields.push(['subsidiary_id', before.subsidiary_id, subsidiaryId])
    if (body.subsidiaryIncludeChildren !== undefined) changedFields.push(['subsidiary_include_children', before.subsidiary_include_children, body.subsidiaryIncludeChildren])
    if (body.status != null) changedFields.push(['status', before.status, body.status])
    if (body.customerPoNumber !== undefined) changedFields.push(['customer_po_number', before.customer_po_number, strOrNull(body.customerPoNumber)])
    if (contractValue !== undefined) changedFields.push(['contract_value', before.contract_value, contractValue])
    if (startsOn !== undefined) changedFields.push(['starts_on', before.starts_on, startsOn])
    if (endsOn !== undefined) changedFields.push(['ends_on', before.ends_on, endsOn])
    if (body.notes !== undefined) changedFields.push(['notes', before.notes, strOrNull(body.notes)])
    if (body.isActive !== undefined) changedFields.push(['is_active', before.is_active, body.isActive])
    if (mergedCustom !== undefined) changedFields.push(['custom', before.custom, mergedCustom])
    if (changedFields.length > 0) {
      const image = Object.fromEntries(changedFields.map(([key, was, now]) => [key, { before: was, after: now }]))
      await db.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${user.orgId}, 'projects', ${id}, 'update', ${JSON.stringify(image)}::jsonb, ${user.id})
      `)
    }
  })
  if (featureRefused) {
    return NextResponse.json({ error: 'projects feature is disabled' }, { status: 404 })
  }
  if (scopeRefused) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const payload = await loadProject(id, user.orgId)
  if (!payload) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const payloadDenied = guardSubsidiaryScope(gate, payload.project.subsidiary_id as string | null | undefined)
  if (payloadDenied) return payloadDenied
  return NextResponse.json(payload)
}

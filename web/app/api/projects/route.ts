import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { canonicalJson } from '@openbooks/engine/src/platform/canonical-json.ts'
import { guardPermission, guardSubsidiaryScope, subsidiariesInScope } from '../../../lib/authz'
import { isUuid } from '../../../lib/list-params'
import { findUnownedCustomReferences, loadFieldDefs, validateCustomValues } from '../../../lib/custom-fields'
import { loadProject } from './_lib'
import { normalizeMoney } from '@openbooks/engine/src/money/money.ts'
import { canonicalDecimal } from '../../../lib/exact-decimal'
import { moneyRefusal } from '../../../lib/payroll-decimal-refusal'
import { isIsoCalendarDate } from '@openbooks/engine/src/platform/business-date.ts'
import { guardProjectsFeature } from '../../../lib/projects-gate'
import { acquireFeatureGateLock, isFeatureEnabled } from '../../../lib/features'

export const runtime = 'nodejs'

const STATUSES = ['quoted', 'awarded', 'active', 'substantially_complete', 'closed', 'cancelled'] as const

function bad(error: string, field?: string, status = 422) {
  return NextResponse.json({ error, ...(field ? { field } : {}) }, { status })
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
  // canonicalDecimal bounds scale, not magnitude: a pasted 20-digit figure
  // would otherwise sail through and die in Postgres as a raw numeric
  // overflow (HTTP 500). contract_value is numeric(19,4): 15 whole digits.
  if (exact.replace(/^[+-]/, '').split('.')[0]!.replace(/^0+/, '').length > 15) return 'invalid'
  try {
    return normalizeMoney(exact)
  } catch {
    return 'invalid'
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

async function partyExists(id: string, orgId: string): Promise<boolean> {
  const r = (await db.execute(
    sql`select 1 from parties where id = ${id} and org_id = ${orgId}`,
  ))
  return !!r.rows[0]
}

/**
 * Create one tenant-owned project.
 *
 * The caller supplies a UUID idempotency key, which becomes the project ID.
 * Retrying the same request therefore returns the same project without a
 * duplicate insert or duplicate audit event. A reused key with a changed
 * payload is a 409, never the older project returned as though it matched.
 *
 * This is the only write path for new projects: the list opens an unsaved
 * drawer (zero writes) and this endpoint persists it exactly once.
 *
 * The write runs under the org's feature-gate fence with the `projects` gate
 * re-checked inside the same transaction: the entry guard above read the gate
 * outside any transaction, so a concurrent feature disable could otherwise
 * commit between that read and this write and strand an active project under a
 * disabled feature. The fence is the same one the disable path holds while it
 * re-evaluates its blockers, so exactly one side wins.
 */
export async function POST(request: Request) {
  const gate = await guardPermission('projects.manage')
  if (gate instanceof NextResponse) return gate
  const feature = await guardProjectsFeature(gate.user.orgId)
  if (feature) return feature
  const user = gate.user

  const requestId = request.headers.get('Idempotency-Key')?.trim() ?? ''
  if (!isUuid(requestId)) return bad('invalid_idempotency_key', undefined, 400)

  const parsedBody = await parseJsonBody(request, jsonObject)
  if (!parsedBody.ok) return parsedBody.response
  const body = parsedBody.data
  if (body.tasks !== undefined) {
    return bad('Work breakdown tasks must be changed through the project task endpoint', 'tasks')
  }
  // Flags ride raw into boolean columns: PostgreSQL would silently coerce
  // spellings like 'off'/'on' or throw 22P02 on anything else. Refuse
  // non-booleans like every other flag write.
  if (body.isActive !== undefined && typeof body.isActive !== 'boolean') {
    return bad('isActive must be a boolean', 'isActive', 400)
  }
  if (body.subsidiaryIncludeChildren !== undefined && typeof body.subsidiaryIncludeChildren !== 'boolean') {
    return bad('subsidiaryIncludeChildren must be a boolean', 'subsidiaryIncludeChildren', 400)
  }

  if (body.status !== undefined && !STATUSES.includes(body.status as (typeof STATUSES)[number])) {
    return bad('Invalid status', 'status')
  }
  const status = typeof body.status === 'string' ? body.status : 'active'

  // A nameless record must never persist: the draft flow stored a 'New
  // project' sentinel, this flow refuses it, so a create can never mint a
  // placeholder that reads as "correctly inactive".
  const name = strOrNull(body.name) ?? ''
  if (!name || name === 'New project') {
    return bad('name_required', 'name')
  }
  const isActive = body.isActive !== false

  let customerId: string | null = null
  if (body.customerId !== undefined) {
    const v = uuidOrNull(body.customerId)
    if (v === 'invalid') return bad('Invalid customer', 'customerId')
    if (v !== null && !(await partyExists(v, user.orgId))) return bad('Customer not found', 'customerId')
    customerId = v
  }
  let foremanId: string | null = null
  if (body.foremanId !== undefined) {
    const v = uuidOrNull(body.foremanId)
    if (v === 'invalid') return bad('Invalid foreman', 'foremanId')
    if (v !== null && !(await partyExists(v, user.orgId))) return bad('Foreman not found', 'foremanId')
    foremanId = v
  }
  let managerId: string | null = null
  if (body.managerId !== undefined) {
    const v = uuidOrNull(body.managerId)
    if (v === 'invalid') return bad('Invalid manager', 'managerId')
    if (v !== null && !(await partyExists(v, user.orgId))) return bad('Manager not found', 'managerId')
    managerId = v
  }

  let subsidiaryId: string | null = null
  if (body.subsidiaryId !== undefined) {
    const value = uuidOrNull(body.subsidiaryId)
    if (value === 'invalid') return bad('Invalid subsidiary', 'subsidiaryId')
    if (!subsidiariesInScope(gate, [value])) return bad('Subsidiary not found', 'subsidiaryId')
    if (value) {
      const subsidiary = ((await db.execute(sql`
        select 1 from subsidiaries
         where id = ${value} and org_id = ${user.orgId} and is_active and not is_elimination`)))
      if (!subsidiary.rows.length) return bad('Subsidiary not found', 'subsidiaryId')
    }
    subsidiaryId = value
  }
  const subsidiaryIncludeChildren =
    body.subsidiaryIncludeChildren !== undefined ? body.subsidiaryIncludeChildren === true : true

  let startsOn: string | null = null
  if (body.startsOn !== undefined) {
    const s = strOrNull(body.startsOn)
    if (s !== null && !isIsoCalendarDate(s)) return bad('Invalid start date', 'startsOn')
    startsOn = s
  }
  let endsOn: string | null = null
  if (body.endsOn !== undefined) {
    const s = strOrNull(body.endsOn)
    if (s !== null && !isIsoCalendarDate(s)) return bad('Invalid end date', 'endsOn')
    endsOn = s
  }

  // Native project-level invoicing override (a real column, not custom jsonb).
  const invoicingRaw = body.invoicingPreference
  const invoicingPreference =
    invoicingRaw == null || (typeof invoicingRaw === 'object' && Object.values(invoicingRaw).every((v) => v == null))
      ? null
      : invoicingRaw as Record<string, unknown>

  const defs = await loadFieldDefs('projects')
  const customResult = validateCustomValues(defs, asRecord(body.custom))
  if (!customResult.ok) return bad('invalid_custom_fields', 'custom')
  // Reference custom values are uuid-SHAPED at this point but nothing proves
  // the referenced row belongs to the caller: refuse foreign or dangling ids
  // instead of persisting a cross-tenant pointer.
  const unowned = await findUnownedCustomReferences(user.orgId, defs, customResult.cleaned)
  if (unowned.length > 0) return bad('unknown_custom_reference', 'custom')
  const custom = customResult.cleaned

  const contractValue = body.contractValue === undefined ? null : moneyOrNull(body.contractValue)
  if (contractValue === 'invalid') return bad(moneyRefusal('Contract value', body.contractValue), 'contractValue')

  // Project type governs the billing classifier (its own billing_method column);
  // the project only stores the type reference.
  let projectTypeId: string | null = null
  if (body.projectTypeId !== undefined) {
    const v = uuidOrNull(body.projectTypeId)
    if (v === 'invalid') return bad('Invalid project type', 'projectTypeId')
    projectTypeId = v
    if (v) {
      const pt = (await db.execute(sql`select 1 from project_types where id = ${v} and org_id = ${user.orgId} and is_active`))
      if (pt.rows.length === 0) return bad('Unknown project type', 'projectTypeId')
    }
  }

  const snapshot = {
    id: requestId,
    org_id: user.orgId,
    name,
    code: strOrNull(body.code),
    customer_id: customerId,
    foreman_id: foremanId,
    manager_id: managerId,
    subsidiary_id: subsidiaryId,
    subsidiary_include_children: subsidiaryIncludeChildren,
    status,
    project_type_id: projectTypeId,
    invoicing_preference: invoicingPreference,
    customer_po_number: strOrNull(body.customerPoNumber),
    contract_value: contractValue,
    starts_on: startsOn,
    ends_on: endsOn,
    notes: strOrNull(body.notes),
    is_active: isActive,
    custom,
  }

  let created = false
  let featureRefused = false
  let scopeRefused = false
  let idempotencyConflict = false
  try {
    await withOrgTransaction(user.orgId, async () => {
    // Serialize against feature toggles, then re-ask the gate the entry guard
    // already asked: its answer may be stale by the time this write lands.
    await acquireFeatureGateLock(user.orgId)
    if (!(await isFeatureEnabled(user.orgId, 'projects'))) {
      featureRefused = true
      return
    }
    if (guardSubsidiaryScope(gate, subsidiaryId)) {
      scopeRefused = true
      return
    }
    const inserted = (await db.execute<{ id: string }>(sql`
      insert into projects
        (id, org_id, name, code, customer_id, foreman_id, manager_id,
         subsidiary_id, subsidiary_include_children, status, project_type_id,
         invoicing_preference, customer_po_number, contract_value,
         starts_on, ends_on, notes, is_active, custom, created_by, updated_by)
      values
        (${requestId}, ${user.orgId}, ${name}, ${strOrNull(body.code)},
         ${customerId}, ${foremanId}, ${managerId},
         ${subsidiaryId}, ${subsidiaryIncludeChildren}, ${status}, ${projectTypeId},
         ${invoicingPreference === null ? sql`null` : sql`${JSON.stringify(invoicingPreference)}::jsonb`},
         ${strOrNull(body.customerPoNumber)}, ${contractValue},
         ${startsOn}, ${endsOn}, ${strOrNull(body.notes)}, ${isActive},
         ${JSON.stringify(custom)}::jsonb, ${user.id}, ${user.id})
      on conflict (id) do nothing
      returning id
    `))
    if (!inserted.rows[0]) {
      const prior = (await db.execute<{ id: string }>(sql`
        select id from projects
         where id = ${requestId} and org_id = ${user.orgId}
      `))
      if (!prior.rows[0]) {
        scopeRefused = true
        return
      }
      // Compare replays with the immutable create snapshot in the insert
      // audit event, rather than today's project row, so an unchanged retry
      // still succeeds even when a later PATCH has legitimately edited it.
      const original = (await db.execute<{ after: unknown }>(sql`
        select changes->'after' as after
          from audit_log
         where org_id = ${user.orgId}
           and table_name = 'projects'
           and row_id = ${requestId}
           and action = 'insert'
           and request_id = ${requestId}
         order by at asc
         limit 1
      `)).rows[0]?.after
      if (!original || canonicalJson(original) !== canonicalJson(snapshot)) {
        throw new Error('idempotency_key_conflict')
      }
      created = false
      return
    }
    // Header creation moves billing caps, ownership, and legal-entity scope,
    // so it carries the same audit row every other material project write does.
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
      values (${user.orgId}, 'projects', ${requestId}, 'insert',
              ${JSON.stringify({ before: null, after: snapshot })}::jsonb, ${user.id}, ${requestId})
    `)
    created = true
    })
  } catch (error) {
    const message = error instanceof Error
      ? `${error.message} ${String((error as { cause?: unknown }).cause ?? '')}`
      : String(error)
    if (message.includes('idempotency_key_conflict')) idempotencyConflict = true
    else throw error
  }
  if (idempotencyConflict) {
    return bad('invalid_idempotency_key', undefined, 409)
  }
  if (featureRefused) {
    return NextResponse.json({ error: 'projects feature is disabled' }, { status: 404 })
  }
  if (scopeRefused) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const payload = await loadProject(requestId, user.orgId, gate.allowedSubsidiaryIds)
  if (!payload) return bad('save_failed', undefined, 500)
  return NextResponse.json(payload, { status: created ? 201 : 200 })
}

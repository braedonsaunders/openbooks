import { uuidId } from "@/lib/api/json-schema"
import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { businessToday, isIsoCalendarDate } from '@openbooks/engine/platform/business-date'
import { db, withOrgTransaction } from '@openbooks/engine/platform/database'
import { guardSubsidiaryScope } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'
import { canonicalDecimal, compareDecimal } from '../../../../lib/exact-decimal'
import { decimalNullRefusal } from '../../../../lib/payroll-decimal-refusal'
import { normalizeMoney } from '@openbooks/engine/money'
import {
  employeePayComponentScopeLock,
  PayrollError,
  validateEmployeePayComponentAssignment,
} from '@openbooks/engine/payroll/assigned-components'
import { notFound } from "@/lib/api/responses";

export const dynamic = 'force-dynamic'

/**
 * Recurring per-employee pay-component assignments — the write side of the
 * rows the pay run prices every regular period (fixed deductions, taxable
 * benefits, employee premiums).
 *
 * GET  ?employee=<partyId>  one employee's assignments + the user-defined
 *                           components they may take + their employments.
 * POST { action:'save-assignment' }  insert one effective-dated row.
 * POST { action:'end-assignment' }    set/clear a row's effective_to.
 * POST { action:'delete-assignment' } remove a row that never reached a stub.
 *
 * Every mutation validates through the payroll service (statutory components
 * refuse, overlaps refuse, Benefits-delivered components refuse naming the
 * rule) and appends an audit_log row with the exact before/after state in the
 * same transaction. A storage refusal past validation (the 0250 overlap
 * exclusion under race) maps to a stable code, never driver text.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** numeric(19,4) ceiling — overrides above this must 422, not overflow mid-write. */
const NUMERIC_19_4_MAX = '999999999999999.9999'

const decimalText = (field: string, noun: string) => z.unknown().transform((value, ctx) => {
  if (typeof value !== "string" || canonicalDecimal(value, 4) === null) {
    ctx.addIssue({ code: "custom", message: decimalNullRefusal(field, noun, value, 4) });
    return z.NEVER;
  }
  return value;
});

const postBodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("save-assignment"),
    employeePartyId: uuidId,
    employmentId: uuidId.nullable().optional(),
    componentId: uuidId,
    value: decimalText("value", "an exact decimal amount").nullable().optional(),
    effectiveFrom: z.string().regex(DATE_RE),
    effectiveTo: z.string().regex(DATE_RE).nullable().optional(),
    reason: z.string().trim().max(500).optional(),
  }),
  z.object({
    action: z.literal("end-assignment"),
    id: uuidId,
    effectiveTo: z.string().regex(DATE_RE).nullable().optional(),
    reason: z.string().trim().max(500).optional(),
  }),
  z.object({
    action: z.literal("delete-assignment"),
    id: uuidId,
    reason: z.string().trim().max(500).optional(),
  }),
]);

type AssignmentRow = {
  id: string
  employeePartyId: string
  employmentId: string | null
  componentId: string
  value: string | null
  effectiveFrom: string
  effectiveTo: string | null
  isActive: boolean
}

const ASSIGNMENT_ROW_COLUMNS = sql`id, employee_party_id as "employeePartyId", employment_id as "employmentId",
  component_id as "componentId", value::text as value,
  effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo", is_active as "isActive"`

function bodyReason(raw: unknown, fallback: string): string {
  return typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 500) : fallback
}

/** Client calendar dates that PostgreSQL would refuse with driver text. */
function invalidDate(value: unknown): boolean {
  return typeof value !== 'string' || !DATE_RE.test(value) || !isIsoCalendarDate(value)
}

/** The 0250 overlap exclusion, anywhere in a cause chain. */
function isOverlapConflict(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    const candidate = current as { code?: string; constraint?: string; cause?: unknown }
    if (candidate.code === '23P01' && candidate.constraint === 'employee_pay_components_no_active_overlap') {
      return true
    }
    current = candidate.cause
  }
  return false
}

function storageRefusal(error: unknown): { error: string; errorCode: string } {
  if (isOverlapConflict(error)) {
    return { error: 'this assignment overlaps an existing assignment for the same component', errorCode: 'overlap' }
  }
  return { error: 'could not save the pay-component assignment', errorCode: 'save' }
}

function refusalResponse(error: unknown): NextResponse {
  if (error instanceof PayrollError) return NextResponse.json({ error: error.message }, { status: 422 })
  return NextResponse.json(storageRefusal(error), { status: 422 })
}

async function locateAssignment(orgId: string, id: string): Promise<AssignmentRow | null> {
  const found = (await db.execute<AssignmentRow>(sql`
    select ${ASSIGNMENT_ROW_COLUMNS} from employee_pay_components
     where org_id = ${orgId} and id = ${id}`)).rows[0]
  return found ?? null
}

async function employeeSubsidiary(orgId: string, employeePartyId: string): Promise<string | null | undefined> {
  const row = (await db.execute<{ subsidiaryId: string | null }>(sql`
    select subsidiary_id as "subsidiaryId" from parties
     where org_id = ${orgId} and id = ${employeePartyId} for share`)).rows[0]
  return row ? row.subsidiaryId : undefined
}

export const GET = defineRoute({
  permission: 'payroll.manage',
  feature: 'payroll',
  handler: async ({ request: req, authz: gate }) => {
    const orgId = gate.user.orgId
    const employee = new URL(req.url).searchParams.get('employee')
    if (!employee || !isUuid(employee)) return NextResponse.json({ error: 'employee required' }, { status: 422 })
    return withOrgTransaction(orgId, async () => {
      const subsidiary = await employeeSubsidiary(orgId, employee)
      if (subsidiary === undefined) return notFound("record")
      const scopeDenied = guardSubsidiaryScope(gate, subsidiary)
      if (scopeDenied) return scopeDenied
      const today = await businessToday(orgId)
      const [assignments, components, employments] = await Promise.all([
        db.execute<Record<string, unknown>>(sql`
          select a.id, a.employee_party_id as "employeePartyId", a.employment_id as "employmentId",
                 a.component_id as "componentId", c.code as "componentCode", c.name as "componentName",
                 c.kind as "componentKind", c.basis as "componentBasis",
                 a.value::text as value, c.value::text as "componentValue",
                 a.effective_from::text as "effectiveFrom", a.effective_to::text as "effectiveTo",
                 a.effective_from <= ${today} and (a.effective_to is null or a.effective_to >= ${today}) as "isCurrent"
            from employee_pay_components a
            join pay_components c on c.org_id = a.org_id and c.id = a.component_id
           where a.org_id = ${orgId} and a.employee_party_id = ${employee} and a.is_active
           order by a.effective_from desc`),
        db.execute<Record<string, unknown>>(sql`
          select c.id, c.code, c.name, c.kind, c.basis, c.value::text as value,
                 c.payment_kind as "paymentKind", c.country
            from pay_components c
           where c.org_id = ${orgId} and c.is_active and c.system_key is null
           order by c.sequence, c.code`),
        db.execute<Record<string, unknown>>(sql`
          select w.id, w.service_start::text as "serviceStart", s.name as "subsidiaryName"
            from worker_employments w
            left join subsidiaries s on s.org_id = w.org_id and s.id = w.employer_subsidiary_id
           where w.org_id = ${orgId} and w.worker_party_id = ${employee}
           order by w.service_start nulls last, w.id`),
      ])
      return NextResponse.json({
        assignments: assignments.rows,
        components: components.rows,
        employments: employments.rows,
      })
    })
  },
});

export const POST = defineRoute({
  permission: 'payroll.manage',
  feature: 'payroll',
  body: postBodySchema,
  handler: async ({ body, authz: gate }) => {
    const orgId = gate.user.orgId
    const userId = gate.user.id

    if (body.action === 'save-assignment') {
      const employeePartyId = body.employeePartyId
      const employmentId = body.employmentId ?? null
      if (invalidDate(body.effectiveFrom)) return NextResponse.json({ error: 'effectiveFrom (YYYY-MM-DD) required' }, { status: 422 })
      if (body.effectiveTo != null && invalidDate(body.effectiveTo)) return NextResponse.json({ error: 'invalid effectiveTo' }, { status: 422 })
      let value: string | null = null
      if (body.value != null) {
        const raw = canonicalDecimal(body.value, 4)
        if (raw === null) return NextResponse.json({ error: decimalNullRefusal('value', 'an exact decimal amount', body.value, 4) }, { status: 422 })
        if (compareDecimal(raw, NUMERIC_19_4_MAX) > 0) return NextResponse.json({ error: 'invalid value' }, { status: 422 })
        try {
          value = normalizeMoney(raw)
        } catch {
          return NextResponse.json({ error: 'invalid value' }, { status: 422 })
        }
      }
      const reason = bodyReason(body.reason, 'pay-component assignment saved')
      try {
        const outcome = await withOrgTransaction(orgId, async () => {
          const subsidiary = await employeeSubsidiary(orgId, employeePartyId)
          if (subsidiary === undefined) return notFound("record")
          const scopeDenied = guardSubsidiaryScope(gate, subsidiary)
          if (scopeDenied) return scopeDenied
          await db.execute(employeePayComponentScopeLock(orgId, employeePartyId))
          const validated = await validateEmployeePayComponentAssignment(db, orgId, {
            employeePartyId, employmentId, componentId: body.componentId, value,
            effectiveFrom: body.effectiveFrom, effectiveTo: body.effectiveTo ?? null,
          })
          const inserted = (await db.execute<{ id: string }>(sql`
            insert into employee_pay_components (org_id, employee_party_id, employment_id, component_id, value,
              effective_from, effective_to, is_active, created_by, updated_by)
            values (${orgId}, ${employeePartyId}, ${employmentId}, ${body.componentId}, ${value},
              ${body.effectiveFrom}::date, ${body.effectiveTo ?? null}::date, true, ${userId}, ${userId})
            returning id`)).rows[0]
          if (!inserted) throw new Error('assignment insert returned no row')
          const after = (await db.execute<AssignmentRow>(sql`
            select ${ASSIGNMENT_ROW_COLUMNS} from employee_pay_components
             where org_id = ${orgId} and id = ${inserted.id}`)).rows[0]
          await db.execute(sql`
            insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
            values (${orgId}, 'employee_pay_components', ${inserted.id}, 'insert',
              ${JSON.stringify({ after, component: validated.componentCode, reason })}, ${userId})`)
          return NextResponse.json({ ok: true, id: inserted.id })
        })
        return outcome
      } catch (e) {
        return refusalResponse(e)
      }
    }

    if (body.action === 'end-assignment') {
      if (body.effectiveTo != null && invalidDate(body.effectiveTo)) return NextResponse.json({ error: 'invalid effectiveTo' }, { status: 422 })
      const reason = bodyReason(body.reason, body.effectiveTo ? 'pay-component assignment ended' : 'pay-component assignment end date cleared')
      try {
        const outcome = await withOrgTransaction(orgId, async () => {
          const row = await locateAssignment(orgId, body.id)
          if (!row) return notFound("record")
          const subsidiary = await employeeSubsidiary(orgId, row.employeePartyId)
          if (subsidiary === undefined) return notFound("record")
          const scopeDenied = guardSubsidiaryScope(gate, subsidiary)
          if (scopeDenied) return scopeDenied
          await db.execute(employeePayComponentScopeLock(orgId, row.employeePartyId))
          // Re-validate the surviving window: a Benefits election or a rival
          // assignment may have arrived since the row was written.
          await validateEmployeePayComponentAssignment(db, orgId, {
            employeePartyId: row.employeePartyId, employmentId: row.employmentId, componentId: row.componentId,
            value: row.value, effectiveFrom: row.effectiveFrom, effectiveTo: body.effectiveTo ?? null,
            excludeId: row.id,
          })
          const updated = (await db.execute<{ id: string }>(sql`
            update employee_pay_components
               set effective_to = ${body.effectiveTo ?? null}::date, updated_at = now(), updated_by = ${userId}
             where org_id = ${orgId} and id = ${row.id} returning id`)).rows
          if (updated.length !== 1) throw new PayrollError('The assignment changed under this save — reload the assignments and try again')
          const after = await locateAssignment(orgId, row.id)
          await db.execute(sql`
            insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
            values (${orgId}, 'employee_pay_components', ${row.id}, 'update',
              ${JSON.stringify({ before: row, after, reason })}, ${userId})`)
          return NextResponse.json({ ok: true })
        })
        return outcome
      } catch (e) {
        return refusalResponse(e)
      }
    }

    const reason = bodyReason(body.reason, 'pay-component assignment deleted')
    try {
      const outcome = await withOrgTransaction(orgId, async () => {
        const row = await locateAssignment(orgId, body.id)
        if (!row) return notFound("record")
        const subsidiary = await employeeSubsidiary(orgId, row.employeePartyId)
        if (subsidiary === undefined) return notFound("record")
        const scopeDenied = guardSubsidiaryScope(gate, subsidiary)
        if (scopeDenied) return scopeDenied
        await db.execute(employeePayComponentScopeLock(orgId, row.employeePartyId))
        // Posted history is immutable: a row that already priced a stub can
        // be ended, never deleted.
        const consumed = (await db.execute(sql`select l.id from pay_stub_lines l
          join pay_stubs s on s.org_id = l.org_id and s.id = l.stub_id
         where l.org_id = ${orgId} and l.component_id = ${row.componentId}
           and s.employee_party_id = ${row.employeePartyId} limit 1`)).rows
        if (consumed.length > 0) {
          return NextResponse.json({ error: 'this assignment already priced a pay stub — end the assignment instead of deleting it' }, { status: 422 })
        }
        const deleted = (await db.execute<{ id: string }>(sql`
          delete from employee_pay_components where org_id = ${orgId} and id = ${row.id} returning id`)).rows
        if (deleted.length !== 1) throw new PayrollError('The assignment changed under this save — reload the assignments and try again')
        await db.execute(sql`
          insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
          values (${orgId}, 'employee_pay_components', ${row.id}, 'delete',
            ${JSON.stringify({ before: row, reason })}, ${userId})`)
        return NextResponse.json({ ok: true })
      })
      return outcome
    } catch (e) {
      return refusalResponse(e)
    }
  },
});

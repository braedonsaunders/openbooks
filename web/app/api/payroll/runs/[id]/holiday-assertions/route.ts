import { NextResponse } from 'next/server'
import { jsonObject, parseJsonBody } from '@/lib/api/json'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { PayrollError } from '@openbooks/engine/src/payroll/error.ts'
import {
  demandingHolidays,
  loadStoredHolidayFacts,
  mergeHolidayEligibility,
  recordHolidayAssertion,
  type DemandingHoliday,
} from '@openbooks/engine/src/payroll/holiday-attestations.ts'
import { guardFeaturePermission } from '../../../../../../lib/feature-gates'
import { guardSubsidiaryScope } from '../../../../../../lib/authz'
import { isUuid } from '../../../../../../lib/list-params'

export const dynamic = 'force-dynamic'

/**
 * Per-holiday statutory-holiday assertions for one pay run (migration 0181).
 *
 *  GET  → every roster employee's standing commission answer, the run's filed
 *         absence assertions, the holidays in the run's period that demand an
 *         explicit fact, and the server-merged `suggested` eligibility map.
 *  POST → file one answer: the standing commission status (stored on the
 *         employee's payroll profile, answered once) and/or one absence
 *         assertion (stored per run + holiday occurrence, never inherited by
 *         a later period).
 *
 * The wizard's calculate action accepts a per-request `holidayEligibility`
 * map and nothing else, so the client sends `suggested` (plus anything the
 * operator just answered) as that map: stored facts reach the engine through
 * the contract it already honours, and an answer missing from both stays
 * missing — the engine fails closed on it by name.
 */

interface RosterEmployee {
  employeePartyId: string
  name: string
  country: string
  province: string
  labourJurisdiction: string | null
  subsidiaryId: string | null
}

async function loadRun(orgId: string, id: string) {
  const rows = (await db.execute<{
    documentId: string; subsidiaryId: string | null; runStatus: string;
    payScheduleId: string; periodStart: string; periodEnd: string;
  }>(sql`
    select r.document_id as "documentId", d.subsidiary_id as "subsidiaryId",
           r.run_status as "runStatus", r.pay_schedule_id as "payScheduleId",
           r.period_start::text as "periodStart", r.period_end::text as "periodEnd"
      from pay_runs r
      join documents d on d.id = r.document_id and d.org_id = r.org_id
     where r.org_id = ${orgId} and r.document_id = ${id}`)).rows[0]
  return rows ?? null
}

async function loadRoster(orgId: string, payScheduleId: string): Promise<RosterEmployee[]> {
  const rows = (await db.execute<Record<string, string | null>>(sql`
    select prof.employee_party_id as "employeePartyId", p.display_name as name,
           prof.country, prof.province,
           prof.labour_jurisdiction as "labourJurisdiction",
           p.subsidiary_id as "subsidiaryId"
      from employee_payroll_profiles prof
      join parties p on p.id = prof.employee_party_id and p.org_id = prof.org_id
     where prof.org_id = ${orgId} and prof.pay_schedule_id = ${payScheduleId}
       and prof.is_active
     order by p.display_name`)).rows
  return rows.map((row) => ({
    employeePartyId: String(row.employeePartyId),
    name: String(row.name),
    country: String(row.country),
    province: String(row.province),
    labourJurisdiction: row.labourJurisdiction ?? null,
    subsidiaryId: row.subsidiaryId ?? null,
  }))
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('payroll.read', 'payroll')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const run = await loadRun(gate.user.orgId, id)
  if (!run) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const denied = guardSubsidiaryScope(gate, run.subsidiaryId)
  if (denied) return denied

  try {
    return await db.transaction(async (tx) => {
      const roster = await loadRoster(gate.user.orgId, run.payScheduleId)
      const employeeIds = roster.map((employee) => employee.employeePartyId)
      const stored = await loadStoredHolidayFacts(tx, {
        orgId: gate.user.orgId, documentId: id, employeePartyIds: employeeIds,
      })
      const demanding = new Map<string, DemandingHoliday[]>()
      for (const employee of roster) {
        demanding.set(employee.employeePartyId, await demandingHolidays(tx, {
          orgId: gate.user.orgId,
          country: employee.country, province: employee.province,
          labourJurisdiction: employee.labourJurisdiction,
          employeeName: employee.name,
          periodStart: run.periodStart, periodEnd: run.periodEnd,
        }))
      }
      const suggested = mergeHolidayEligibility(undefined, stored, demanding)
      return NextResponse.json({
        employees: roster.map((employee) => {
          const perEmployee = stored.assertions.get(employee.employeePartyId) ?? new Map<string, boolean>()
          return {
            employeePartyId: employee.employeePartyId,
            name: employee.name,
            paidOnCommission: stored.commissions.get(employee.employeePartyId) ?? null,
            assertions: [...perEmployee.entries()].map(([occurrence, absentWithoutConsent]) => {
              const separator = occurrence.lastIndexOf('|')
              return {
                holidayKey: occurrence.slice(0, separator),
                holidayDate: occurrence.slice(separator + 1),
                absentWithoutConsent,
              }
            }),
            demanding: demanding.get(employee.employeePartyId) ?? [],
          }
        }),
        suggested,
      })
    })
  } catch (error) {
    if (error instanceof PayrollError) return NextResponse.json({ error: error.message }, { status: 422 })
    throw error
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('payroll.run', 'payroll')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const run = await loadRun(gate.user.orgId, id)
  if (!run) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const denied = guardSubsidiaryScope(gate, run.subsidiaryId)
  if (denied) return denied
  if (run.runStatus !== 'draft' && run.runStatus !== 'calculated') {
    return NextResponse.json({ error: 'assertions can only be filed on an uncommitted run' }, { status: 422 })
  }
  // Through the shared boundary like every other mutation route, so the
  // financial-boundary guard holds: a route that parses its own body is a
  // route whose validation nobody can audit centrally.
  const parsedBody = await parseJsonBody(req, jsonObject)
  if (!parsedBody.ok) return parsedBody.response
  const body = parsedBody.data as {
    employeePartyId?: unknown; paidOnCommission?: unknown;
    holidayKey?: unknown; holidayDate?: unknown; absentWithoutConsent?: unknown;
  }
  const { employeePartyId, paidOnCommission } = body
  if (typeof employeePartyId !== 'string' || !isUuid(employeePartyId)) {
    return NextResponse.json({ error: 'invalid employee' }, { status: 422 })
  }
  const answersCommission = paidOnCommission !== undefined
  if (answersCommission && typeof paidOnCommission !== 'boolean') {
    return NextResponse.json({ error: 'invalid commission-pay status' }, { status: 422 })
  }
  const { holidayKey, holidayDate, absentWithoutConsent } = body
  const answersAbsence = absentWithoutConsent !== undefined
  if (answersAbsence && typeof absentWithoutConsent !== 'boolean') {
    return NextResponse.json({ error: 'invalid absence assertion' }, { status: 422 })
  }
  if (!answersCommission && !answersAbsence) {
    return NextResponse.json({ error: 'nothing to file' }, { status: 422 })
  }
  // An explicit holiday identity must be well-formed; an omitted one is
  // resolved below, and only when the run leaves no room for doubt.
  if (holidayKey !== undefined && (typeof holidayKey !== 'string' || holidayKey.trim().length === 0)) {
    return NextResponse.json({ error: 'invalid holiday' }, { status: 422 })
  }
  if (holidayDate !== undefined && (typeof holidayDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(holidayDate))) {
    return NextResponse.json({ error: 'invalid holiday' }, { status: 422 })
  }

  try {
    return await withOrgTransaction(gate.user.orgId, async () => {
      // The employee must be on this run's roster: unknown ids are refused
      // rather than silently unattested.
      const roster = await loadRoster(gate.user.orgId, run.payScheduleId)
      const employee = roster.find((entry) => entry.employeePartyId === employeePartyId)
      if (!employee) return NextResponse.json({ error: 'employee is not on this run' }, { status: 422 })
      const employeeDenied = guardSubsidiaryScope(gate, employee.subsidiaryId)
      if (employeeDenied) return employeeDenied

      if (answersCommission) {
        await db.execute(sql`
          update employee_payroll_profiles
             set paid_on_commission = ${paidOnCommission as boolean},
                 updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond'),
                 updated_by = ${gate.user.id}
           where org_id = ${gate.user.orgId} and employee_party_id = ${employeePartyId}`)
      }

      let filed: { holidayKey: string; holidayDate: string } | null = null
      if (answersAbsence) {
        const candidates = (await demandingHolidays(db, {
          orgId: gate.user.orgId,
          country: employee.country, province: employee.province,
          labourJurisdiction: employee.labourJurisdiction,
          employeeName: employee.name,
          periodStart: run.periodStart, periodEnd: run.periodEnd,
        })).filter((holiday) => holiday.needsAbsenceAssertion)
        let target: DemandingHoliday | null = null
        if (holidayKey !== undefined || holidayDate !== undefined) {
          // An explicitly named holiday must be one of the run's demanding
          // occurrences — filing against any other day would answer a
          // question the statute never asked.
          target = candidates.find((holiday) =>
            holiday.key === holidayKey && holiday.date === holidayDate) ?? null
          if (!target) return NextResponse.json({ error: 'no demanding holiday matches' }, { status: 422 })
        } else if (candidates.length === 1) {
          target = candidates[0]!
        } else {
          return NextResponse.json(
            { error: candidates.length === 0 ? 'no holiday in this run demands the assertion' : 'specify which holiday' },
            { status: 422 },
          )
        }
        filed = await recordHolidayAssertion(db, {
          orgId: gate.user.orgId, documentId: id, employeePartyId,
          holidayKey: target.key, holidayDate: target.date,
          absentWithoutConsent: absentWithoutConsent as boolean,
          actorId: gate.user.id,
        })
      }
      return NextResponse.json({ ok: true, filed })
    })
  } catch (error) {
    if (error instanceof PayrollError) return NextResponse.json({ error: error.message }, { status: 422 })
    throw error
  }
}

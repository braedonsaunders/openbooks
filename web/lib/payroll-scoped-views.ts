import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import {
  entitlementOpenings,
  type EntitlementOpeningsResult,
} from '@openbooks/engine/src/payroll-entitlements-openings.ts'
import {
  openingBalancesForYear,
  type OpeningBalanceYear,
} from '@openbooks/engine/src/payroll-opening-balances.ts'
import {
  payrollRemittanceSummary,
  type RemittanceGroup,
} from '@openbooks/engine/src/payroll-remittance.ts'
import {
  orgYearEndFilings,
  type YearEndFilingSection,
} from '@openbooks/engine/src/payroll-yearend.ts'
import {
  guardPayrollYearEndFilings,
  guardRemittancePeriod,
  payrollVisibleScheduleFilter,
  visiblePayrollEmployeeIds,
} from '../app/api/payroll/subsidiary-scope'
import type { Authz } from './authz'

/**
 * Payroll reads that carry the caller's subsidiary scope.
 *
 * Every payroll population has exactly one scope decision, made here, and the
 * three transports that render it (the server pages, the JSON routes and the
 * assistant tools) all call these loaders. A page that called the engine
 * directly showed a restricted caller wage data its own API refused with 404;
 * the loaders make that divergence impossible by construction.
 *
 * `null` means the population is refused for this caller. Callers translate it
 * into their transport's not-found response (`notFound()`, a 404 body, or a
 * `not_found` tool error) so a hidden population is indistinguishable from an
 * absent one.
 */

export async function scopedYearEndFilings(
  gate: Authz,
  taxYear: number,
): Promise<YearEndFilingSection[] | null> {
  const filings = await orgYearEndFilings(gate.user.orgId, taxYear)
  const denied = await guardPayrollYearEndFilings(gate, filings)
  return denied ? null : filings
}

export async function scopedRemittanceSummary(
  gate: Authz,
  range: { from: string; to: string },
): Promise<RemittanceGroup[] | null> {
  const denied = await guardRemittancePeriod(gate, range.from, range.to)
  if (denied) return null
  return payrollRemittanceSummary(gate.user.orgId, range)
}

/** Opening balances for a tax year, limited to the employees the caller may see. */
export async function scopedOpeningBalances(
  gate: Authz,
  taxYear: number,
): Promise<OpeningBalanceYear> {
  const data = await openingBalancesForYear(gate.user.orgId, taxYear)
  const visible = await visiblePayrollEmployeeIds(gate)
  if (!visible) return data
  const rows = data.rows.filter((row) => visible.has(row.employeePartyId))
  const years = (await db.execute<{ taxYear: number }>(sql`
    select distinct b.tax_year as "taxYear"
      from payroll_opening_balances b
      join parties p on p.id = b.employee_party_id and p.org_id = b.org_id
     where b.org_id = ${gate.user.orgId}
       and p.id = any(${`{${[...visible].join(',')}}`}::uuid[])
     order by b.tax_year desc`)).rows.map((row) => Number(row.taxYear))
  return {
    ...data,
    rows,
    entered: rows.filter((row) => row.amounts !== null).length,
    years,
  }
}

/** Entitlement bank carry-ins, limited to the employees the caller may see. */
export async function scopedEntitlementOpenings(
  gate: Authz,
  opts: { asOf?: string } = {},
): Promise<EntitlementOpeningsResult> {
  const data = await entitlementOpenings(gate.user.orgId, opts)
  const visible = await visiblePayrollEmployeeIds(gate)
  if (!visible) return data
  const rows = data.rows.filter((row) => visible.has(row.employeePartyId))
  return {
    ...data,
    rows,
    entered: rows.filter((row) => Object.keys(row.amounts).length > 0).length,
    blocked: Object.fromEntries(
      Object.entries(data.blocked).filter(([employeePartyId]) => visible.has(employeePartyId)),
    ),
  }
}

/** Active schedules with committed history, visible to the caller. */
export async function scopedRetroSchedules(gate: Authz): Promise<{ id: string; name: string }[]> {
  return (await db.execute<{ id: string; name: string }>(sql`
    select s.id, s.name
      from pay_schedules s
     where s.org_id = ${gate.user.orgId} and s.is_active
       ${payrollVisibleScheduleFilter(gate)}
       -- Only a schedule that has actually paid something can owe retro.
       and exists (
         select 1 from pay_runs r
          where r.org_id = s.org_id and r.pay_schedule_id = s.id
            and r.run_status = 'committed')
     order by s.name
  `)).rows
}

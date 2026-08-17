import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import {
  assertTaxYear,
  isEmptyOpeningBalance,
  normalizeOpeningBalance,
  openingBalanceLocks,
  OPENING_BALANCE_FIELDS,
  saveOpeningBalances,
} from '@openbooks/engine/src/payroll-opening-balances.ts'
import type { CellValue, ResourceDescriptor, ResourceField, WriteOutcome } from './types'
import type { DataResource, WriteCtx } from './resources'

/**
 * Mid-year adoption carry-in as an import/export resource.
 *
 * Adoption is a WHOLE-WORKFORCE exercise: the operator has one year-to-date
 * report from the outgoing provider and several hundred employees. Typing that
 * into a grid one person at a time is how a row gets skipped, and a skipped
 * row costs that employee a second annual CPP/EI maximum. So the bulk path is
 * the generic import/export machinery — the same mapping wizard, dry-run
 * preview and CSV/XLSX/JSON parsers every other resource uses — rather than a
 * bespoke uploader with its own file handling.
 *
 * Every write still goes through engine/src/payroll-opening-balances.ts, so an
 * import cannot bypass the money validation or the refusal to restate a
 * carry-in a committed run already consumed.
 */

const MAX_EXPORT_ROWS = 50_000

export const PAYROLL_OPENING_BALANCES_KEY = 'payroll-opening-balances'

export const PAYROLL_OPENING_BALANCES_DESCRIPTOR: ResourceDescriptor = {
  key: PAYROLL_OPENING_BALANCES_KEY,
  label: 'Payroll opening balances',
  group: 'Setup',
  iconKey: 'history',
  readPermission: 'payroll.read',
  writePermission: 'payroll.manage',
  supportsImport: true,
  naturalKey: 'employee + taxYear',
}

function fields(): ResourceField[] {
  return [
    {
      key: 'employee',
      label: 'Employee (number, code, or name)',
      kind: 'reference',
      required: true,
      ref: { resource: 'parties', by: 'shortCode' },
    },
    { key: 'employeeName', label: 'Employee name', kind: 'text', readOnly: true },
    { key: 'taxYear', label: 'Tax year', kind: 'number', required: true },
    ...OPENING_BALANCE_FIELDS.map((field) => ({
      key: field.key,
      label: field.label,
      kind: 'currency' as const,
    })),
  ]
}

/**
 * Resolve whatever the prior provider's report calls a person: the payroll
 * number first (what those reports actually carry), then the party short code,
 * then the display name. An ambiguous name is REFUSED rather than guessed —
 * loading one Chen's year-to-date onto the other Chen is silent and expensive.
 *
 * The population is "somebody payroll knows about" — a party carrying an
 * employee role or a payroll profile — deliberately NOT `parties.kind = 'person'`.
 * `kind` is `'employee'` in tenants provisioned through the employee entity, so
 * a kind filter silently resolves nobody and every row of a real carry-in file
 * fails to import, which strands a mid-year adopter with no way to load their
 * opening balances at all. The role/profile join is also the stricter test: it
 * cannot match a customer contact who happens to share a name with an employee.
 */
async function resolveEmployee(
  orgId: string,
  raw: unknown,
): Promise<{ id: string } | { error: string }> {
  const value = String(raw ?? '').trim()
  if (!value) return { error: 'employee is required' }
  const matches = (await db.execute(sql`
    select distinct p.id, p.display_name
      from parties p
      left join employee_roles er on er.party_id = p.id and er.org_id = p.org_id
      left join employee_payroll_profiles prof
        on prof.employee_party_id = p.id and prof.org_id = p.org_id
     where p.org_id = ${orgId}
       and (er.party_id is not null or prof.employee_party_id is not null)
       and (p.id::text = ${value}
            or er.employee_number = ${value}
            or p.short_code = ${value}
            or p.display_name = ${value})
     limit 3
  `)) as { rows: { id: string; display_name: string }[] }
  if (matches.rows.length === 0) {
    return { error: `employee "${value}" not found — no payroll number, code, or name matches` }
  }
  if (matches.rows.length > 1) {
    return { error: `employee "${value}" matches more than one person — use the payroll number` }
  }
  return { id: matches.rows[0]!.id }
}

export function payrollOpeningBalancesResource(orgId: string): DataResource {
  const resourceFields = fields()
  const columns = resourceFields.map((f) => ({ key: f.key, label: f.label }))
  const amountCols = OPENING_BALANCE_FIELDS.map((f) => sql.raw(`b.${f.column} as "${f.key}"`))

  return {
    descriptor: PAYROLL_OPENING_BALANCES_DESCRIPTOR,
    async fields() {
      return resourceFields
    },
    async columns() {
      return columns
    },
    async read() {
      const result = (await db.execute(sql`
        select coalesce(er.employee_number, p.short_code, p.display_name) as "employee",
               p.display_name as "employeeName",
               b.tax_year as "taxYear",
               ${sql.join(amountCols, sql`, `)}
          from payroll_opening_balances b
          join parties p on p.id = b.employee_party_id and p.org_id = b.org_id
          left join employee_roles er on er.party_id = p.id and er.org_id = b.org_id
         where b.org_id = ${orgId}
         order by b.tax_year desc, p.display_name
         limit ${MAX_EXPORT_ROWS}`)) as { rows: Record<string, CellValue>[] }
      return { fields: resourceFields, columns, rows: result.rows }
    },
    async write(rows, _mode, ctx: WriteCtx) {
      const outcome: WriteOutcome = { created: 0, updated: 0, failed: 0, errors: [] }
      // Locks and existing rows are per tax year; cache them so a 500-row load
      // is not 500 extra round trips.
      const lockCache = new Map<number, Awaited<ReturnType<typeof openingBalanceLocks>>>()
      const existingCache = new Map<number, Set<string>>()

      for (let index = 0; index < rows.length; index++) {
        const rowNo = index + 1
        const src = rows[index]
        try {
          const taxYear = assertTaxYear(src.taxYear)
          const employee = await resolveEmployee(ctx.orgId, src.employee)
          if ('error' in employee) {
            outcome.failed++
            outcome.errors.push({ row: rowNo, message: employee.error, field: 'employee' })
            continue
          }

          if (!lockCache.has(taxYear)) {
            lockCache.set(taxYear, await openingBalanceLocks(ctx.orgId, taxYear))
            const existing = (await db.execute(sql`
              select employee_party_id from payroll_opening_balances
               where org_id = ${ctx.orgId} and tax_year = ${taxYear}`)) as {
              rows: { employee_party_id: string }[]
            }
            existingCache.set(taxYear, new Set(existing.rows.map((r) => r.employee_party_id)))
          }
          const lock = lockCache.get(taxYear)!.get(employee.id)
          if (lock) {
            outcome.failed++
            outcome.errors.push({
              row: rowNo,
              message: `a pay run committed on ${lock.payDate} already used this carry-in for ${taxYear}; void that run before changing it`,
            })
            continue
          }

          // Validate in both modes so the wizard's preview is a real preview.
          const amounts = normalizeOpeningBalance(src)
          const existed = existingCache.get(taxYear)!.has(employee.id)
          if (ctx.dryRun) {
            if (isEmptyOpeningBalance(amounts) && !existed) outcome.updated++
            else if (existed) outcome.updated++
            else outcome.created++
            continue
          }

          const result = await saveOpeningBalances({
            orgId: ctx.orgId,
            actorId: ctx.actorId,
            taxYear,
            rows: [{ employeePartyId: employee.id, amounts: src }],
          })
          outcome.created += result.created
          outcome.updated += result.updated + result.deleted
          if (result.created > 0) existingCache.get(taxYear)!.add(employee.id)
        } catch (error) {
          outcome.failed++
          outcome.errors.push({
            row: rowNo,
            message: error instanceof Error ? error.message : 'write failed',
          })
        }
      }
      return outcome
    },
  }
}

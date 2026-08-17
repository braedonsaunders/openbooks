import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { cmp, normalizeMoney } from '@openbooks/engine/src/money.ts'
import {
  assertTaxYear,
  isEmptyOpeningBalance,
  normalizeOpeningBalance,
  normalizeOpeningComponents,
  openingBalanceLocks,
  openingComponentFields,
  OPENING_BALANCE_FIELDS,
  saveOpeningBalances,
  type OpeningComponentField,
} from '@openbooks/engine/src/payroll-opening-balances.ts'
import {
  assertMovementDate,
  entitlementOpeningLocks,
  entitlementPlans,
  saveEntitlementOpenings,
  type EntitlementPlan,
} from '@openbooks/engine/src/payroll-entitlements.ts'
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

/**
 * Component openings become one column per annually-capped component, named
 * `component:<CODE>` — the code, because that is what an operator recognizes in
 * a spreadsheet header and what survives being exported from one environment and
 * imported into another. The engine resolves either the code or the uuid, so the
 * importer does not own a second resolver.
 */
const COMPONENT_PREFIX = 'component:'

function componentColumnKey(component: OpeningComponentField): string {
  return `${COMPONENT_PREFIX}${component.code}`
}

/**
 * The `component:` cells of one file row, keyed by component code.
 *
 * `undefined` when the row carries no component column at all — a file exported
 * before these existed, or one an operator trimmed. Silence is not an
 * instruction to delete an employee's deferral year-to-date, and the engine
 * treats `undefined` as "keep what is stored".
 */
function componentAmountsFrom(
  src: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const amounts: Record<string, unknown> = {}
  let present = false
  for (const [key, value] of Object.entries(src)) {
    if (!key.startsWith(COMPONENT_PREFIX)) continue
    present = true
    amounts[key.slice(COMPONENT_PREFIX.length)] = value
  }
  return present ? amounts : undefined
}

function fields(components: readonly OpeningComponentField[]): ResourceField[] {
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
    ...components.map((component) => ({
      key: componentColumnKey(component),
      label: `${component.name} year-to-date`,
      kind: 'currency' as const,
      // A component whose annual cap has been removed is inert: the amount is
      // exported so nothing is hidden, and refused on import so nobody enters a
      // number that changes nothing.
      readOnly: !component.capped,
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
  const amountCols = OPENING_BALANCE_FIELDS.map((f) => sql.raw(`b.${f.column} as "${f.key}"`))
  // The capped-component list is org configuration, so it is loaded once per
  // resource instance and shared by fields(), columns(), read() and write().
  let componentsPromise: Promise<OpeningComponentField[]> | null = null
  const loadComponents = () => {
    componentsPromise ??= openingComponentFields(orgId, null)
    return componentsPromise
  }

  return {
    descriptor: PAYROLL_OPENING_BALANCES_DESCRIPTOR,
    async fields() {
      return fields(await loadComponents())
    },
    async columns() {
      return (await this.fields()).map((f) => ({ key: f.key, label: f.label }))
    },
    async read() {
      const components = await loadComponents()
      const resourceFields = fields(components)
      const columns = resourceFields.map((f) => ({ key: f.key, label: f.label }))
      const result = (await db.execute(sql`
        select b.id as "__rowId",
               coalesce(er.employee_number, p.short_code, p.display_name) as "employee",
               p.display_name as "employeeName",
               b.tax_year as "taxYear",
               ${sql.join(amountCols, sql`, `)}
          from payroll_opening_balances b
          join parties p on p.id = b.employee_party_id and p.org_id = b.org_id
          left join employee_roles er on er.party_id = p.id and er.org_id = b.org_id
         where b.org_id = ${orgId}
         order by b.tax_year desc, p.display_name
         limit ${MAX_EXPORT_ROWS}`)) as { rows: Record<string, CellValue>[] }

      // Component openings pivot onto their parent row. Joining them in SQL
      // would multiply the rows; the export is one row per carry-in.
      const componentRows = (await db.execute(sql`
        select oc.opening_balance_id, c.code, oc.ytd_amount::text as amount
          from payroll_opening_balance_components oc
          join pay_components c on c.id = oc.component_id and c.org_id = oc.org_id
         where oc.org_id = ${orgId}`)) as {
        rows: { opening_balance_id: string; code: string; amount: string }[]
      }
      const byRow = new Map<string, Record<string, string>>()
      for (const row of componentRows.rows) {
        const amounts = byRow.get(row.opening_balance_id) ?? {}
        amounts[`${COMPONENT_PREFIX}${row.code}`] = row.amount
        byRow.set(row.opening_balance_id, amounts)
      }
      const rows = result.rows.map((row) => {
        const rowId = String(row.__rowId ?? '')
        const { __rowId: _drop, ...rest } = row
        const out: Record<string, CellValue> = { ...rest }
        for (const component of components) out[componentColumnKey(component)] = null
        for (const [key, value] of Object.entries(byRow.get(rowId) ?? {})) out[key] = value
        return out
      })
      return { fields: resourceFields, columns, rows }
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
          const components = componentAmountsFrom(src)
          const normalizedComponents = components === undefined
            ? {}
            : normalizeOpeningComponents(components, await loadComponents())
          const existed = existingCache.get(taxYear)!.has(employee.id)
          if (ctx.dryRun) {
            if (isEmptyOpeningBalance(amounts, normalizedComponents) && !existed) outcome.updated++
            else if (existed) outcome.updated++
            else outcome.created++
            continue
          }

          const result = await saveOpeningBalances({
            orgId: ctx.orgId,
            actorId: ctx.actorId,
            taxYear,
            rows: [{ employeePartyId: employee.id, amounts: src, components }],
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

/* ------------------------------------------------------------------ */
/* Bank carry-ins (entitlement plans)                                  */
/* ------------------------------------------------------------------ */

export const PAYROLL_OPENING_ENTITLEMENTS_KEY = 'payroll-opening-entitlements'

/**
 * A SEPARATE resource, not more columns on the one above, because the natural
 * key differs: a statutory carry-in is (employee, tax year) and a bank carry-in
 * is (employee, plan) with no year at all. Sharing one resource would give the
 * mapping wizard a natural key that is right for half its columns, and would
 * make "load 2027's file" silently re-date every bank.
 *
 * The write path is not separate: both go through
 * engine/src/payroll-entitlements.ts, so an import cannot bypass the sign check
 * against the plan's direction or the refusal to restate a carry-in a committed
 * run consumed.
 */
export const PAYROLL_OPENING_ENTITLEMENTS_DESCRIPTOR: ResourceDescriptor = {
  key: PAYROLL_OPENING_ENTITLEMENTS_KEY,
  label: 'Payroll opening bank balances (vacation, banked time)',
  group: 'Setup',
  iconKey: 'history',
  readPermission: 'payroll.read',
  writePermission: 'payroll.manage',
  supportsImport: true,
  naturalKey: 'employee + plan',
}

function entitlementFields(plans: readonly EntitlementPlan[]): ResourceField[] {
  return [
    {
      key: 'employee',
      label: 'Employee (number, code, or name)',
      kind: 'reference',
      required: true,
      ref: { resource: 'parties', by: 'shortCode' },
    },
    { key: 'employeeName', label: 'Employee name', kind: 'text', readOnly: true },
    {
      key: 'plan',
      label: 'Entitlement plan (code)',
      kind: 'select',
      required: true,
      options: plans.map((plan) => ({ value: plan.code, label: plan.name })),
    },
    {
      key: 'asOf',
      label: 'Carried in as at (YYYY-MM-DD)',
      kind: 'date',
      required: true,
    },
    { key: 'amount', label: 'Balance carried in', kind: 'currency', required: true },
  ]
}

export function payrollOpeningEntitlementsResource(orgId: string): DataResource {
  let plansPromise: Promise<EntitlementPlan[]> | null = null
  const loadPlans = () => {
    plansPromise ??= entitlementPlans(orgId)
    return plansPromise
  }

  return {
    descriptor: PAYROLL_OPENING_ENTITLEMENTS_DESCRIPTOR,
    async fields() {
      return entitlementFields(await loadPlans())
    },
    async columns() {
      return (await this.fields()).map((f) => ({ key: f.key, label: f.label }))
    },
    async read() {
      const resourceFields = entitlementFields(await loadPlans())
      const columns = resourceFields.map((f) => ({ key: f.key, label: f.label }))
      const result = (await db.execute(sql`
        select coalesce(er.employee_number, p.short_code, p.display_name) as "employee",
               p.display_name as "employeeName",
               pl.code as "plan",
               l.movement_date::text as "asOf",
               l.amount::text as "amount"
          from entitlement_ledger l
          join entitlement_plans pl on pl.id = l.plan_id and pl.org_id = l.org_id
          join parties p on p.id = l.employee_party_id and p.org_id = l.org_id
          left join employee_roles er on er.party_id = p.id and er.org_id = l.org_id
         where l.org_id = ${orgId} and l.kind = 'opening'
         order by pl.code, p.display_name
         limit ${MAX_EXPORT_ROWS}`)) as { rows: Record<string, CellValue>[] }
      return { fields: resourceFields, columns, rows: result.rows }
    },
    async write(rows, _mode, ctx: WriteCtx) {
      const outcome: WriteOutcome = { created: 0, updated: 0, failed: 0, errors: [] }
      const plans = await loadPlans()
      const planByCode = new Map(plans.map((plan) => [plan.code.trim().toLowerCase(), plan]))
      const locks = await entitlementOpeningLocks(ctx.orgId)

      for (let index = 0; index < rows.length; index++) {
        const rowNo = index + 1
        const src = rows[index]
        try {
          const employee = await resolveEmployee(ctx.orgId, src.employee)
          if ('error' in employee) {
            outcome.failed++
            outcome.errors.push({ row: rowNo, message: employee.error, field: 'employee' })
            continue
          }
          const planKey = String(src.plan ?? '').trim().toLowerCase()
          const plan = planByCode.get(planKey)
          if (!plan) {
            outcome.failed++
            outcome.errors.push({
              row: rowNo,
              message: `"${String(src.plan ?? '')}" is not an active entitlement plan`,
              field: 'plan',
            })
            continue
          }
          const asOf = assertMovementDate(src.asOf)
          const lock = locks.get(`${plan.id}:${employee.id}`)
          if (lock) {
            outcome.failed++
            outcome.errors.push({
              row: rowNo,
              message: `a pay run committed on ${lock.payDate} already used the ${plan.code} carry-in; void that run before changing it`,
            })
            continue
          }

          // The amount and its SIGN are validated in both modes: a preview that
          // only counts rows lets an operator approve a load that then fails
          // halfway, and the sign is the error that matters here (an 'owe'
          // balance entered positive is a credit on a real cheque).
          const amount = normalizeMoney(String(src.amount ?? '').trim().replace(/[,$]/g, '') || '0')
          if (plan.direction === 'accrue' && cmp(amount, '0') < 0) {
            throw new Error(`${plan.code} is a bank the employer owes, so its carry-in cannot be negative`)
          }
          if (plan.direction === 'owe' && cmp(amount, '0') > 0) {
            throw new Error(`${plan.code} is a balance the EMPLOYEE owes, so its carry-in must be negative`)
          }
          if (ctx.dryRun) {
            outcome.created++
            continue
          }

          const result = await saveEntitlementOpenings({
            orgId: ctx.orgId,
            actorId: ctx.actorId,
            movementDate: asOf,
            rows: [{ employeePartyId: employee.id, amounts: { [plan.code]: src.amount } }],
          })
          outcome.created += result.created
          outcome.updated += result.updated + result.deleted
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

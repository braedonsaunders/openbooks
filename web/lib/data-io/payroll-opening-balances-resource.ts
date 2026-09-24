import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { cmp } from '@openbooks/engine/src/money/money.ts'
import { parseEntitlementCarryInAmount } from '@openbooks/engine/src/payroll/entitlements-openings-save.ts'
import {
  assertTaxYear,
  declaredProgramBaseFields,
  isEmptyOpeningBalance,
  normalizeOpeningBalance,
  normalizeOpeningComponents,
  normalizeOpeningProgramBases,
  openingBalanceLocks,
  openingComponentFields,
  OPENING_BALANCE_FIELDS,
  saveOpeningBalances,
  type DeclaredProgramBaseField,
  type OpeningComponentField,
} from '@openbooks/engine/src/payroll/opening-balances.ts'
import {
  assertMovementDate,
  entitlementOpeningLocks,
  entitlementPlans,
  saveEntitlementOpenings,
  type EntitlementPlan,
} from '@openbooks/engine/src/payroll/entitlements.ts'
import type { CellValue, ResourceDescriptor, ResourceField, WriteOutcome } from './types'
import type { DataResource, WriteCtx } from './resources'
import {
  enforceExportRowLimit,
  MAX_EXPORT_ROWS,
  subsidiaryReadFilterWithUnassigned,
  type ReadCtx,
} from './resource-core'
import { employeeWriteScopeError } from './write-scope'

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
 * Every write still goes through engine/src/payroll/opening-balances.ts, so an
 * import cannot bypass the money validation or the refusal to restate a
 * carry-in a committed run already consumed.
 */

// Row cap is the canonical MAX_EXPORT_ROWS from ./resource-core (a second
// local copy would let the two caps drift, silently reintroducing this bug).
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
  scopedWrite: true,
}

/**
 * Component openings become one column per annually-capped component, named
 * `component:<CODE>` — the code, because that is what an operator recognizes in
 * a spreadsheet header and what survives being exported from one environment and
 * imported into another. The engine resolves either the code or the uuid, so the
 * importer does not own a second resolver.
 */
const COMPONENT_PREFIX = 'component:'

/**
 * Per-program insurable-earnings carry-ins become one column per declared
 * contribution program, named `program:<KEY>` — the program key, because
 * that is what the pack declares and what survives being exported from one
 * environment and imported into another. Labels come from the pack
 * declaration (English fallback, like the declaration itself): no catalog
 * key is minted per program.
 */
const PROGRAM_PREFIX = 'program:'

/**
 * Advisory for a row that carries no amounts where no carry-in is stored.
 * The commit genuinely writes nothing (the engine deletes nothing and counts
 * nothing), so both preview and commit report the row as a warning rather
 * than a created/updated count — a blank line in a file must never read as
 * progress.
 */
const NOTHING_TO_WRITE = 'row carries no amounts and no carry-in is stored — nothing to write'

function componentColumnKey(component: OpeningComponentField): string {
  return `${COMPONENT_PREFIX}${component.code}`
}

function programColumnKey(programKey: string): string {
  return `${PROGRAM_PREFIX}${programKey}`
}

/**
 * The `program:` cells of one file row, keyed by program key.
 *
 * `undefined` when the row carries no program column at all — a file
 * exported before these existed, or one an operator trimmed. Silence is not
 * an instruction to delete an employee's program base, and the engine treats
 * `undefined` as "keep what is stored".
 */
function programAmountsFrom(
  src: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const amounts: Record<string, unknown> = {}
  let present = false
  for (const [key, value] of Object.entries(src)) {
    if (!key.startsWith(PROGRAM_PREFIX)) continue
    present = true
    amounts[key.slice(PROGRAM_PREFIX.length)] = value
  }
  return present ? amounts : undefined
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

function fields(
  components: readonly OpeningComponentField[],
  programs: readonly DeclaredProgramBaseField[],
): ResourceField[] {
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
    ...programs.map((program) => ({
      key: programColumnKey(program.programKey),
      label: `${program.label} carry-in`,
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
  // Pack-declared contribution programs are code, not org configuration, but
  // loading them once per instance keeps fields(), columns(), read() and
  // write() on the same vocabulary for the file.
  let programsPromise: Promise<DeclaredProgramBaseField[]> | null = null
  const loadPrograms = () => {
    programsPromise ??= declaredProgramBaseFields()
    return programsPromise
  }

  return {
    descriptor: PAYROLL_OPENING_BALANCES_DESCRIPTOR,
    async fields() {
      return fields(await loadComponents(), await loadPrograms())
    },
    async columns() {
      return (await this.fields()).map((f) => ({ key: f.key, label: f.label }))
    },
    async read(readCtx?: ReadCtx) {
      const components = await loadComponents()
      const programs = await loadPrograms()
      const resourceFields = fields(components, programs)
      const columns = resourceFields.map((f) => ({ key: f.key, label: f.label }))
      // Employee visibility is decided by the PARTY's subsidiary, in SQL —
      // never by matching the exported employee label afterwards, which a
      // same-named employee in another legal entity would also match.
      const result = (await db.execute(sql`
        select b.id as "__rowId",
               b.employee_party_id as "__employeeId",
               coalesce(er.employee_number, p.short_code, p.display_name) as "employee",
               p.display_name as "employeeName",
               b.tax_year as "taxYear",
               ${sql.join(amountCols, sql`, `)}
          from payroll_opening_balances b
          join parties p on p.id = b.employee_party_id and p.org_id = b.org_id
          left join employee_roles er on er.party_id = p.id and er.org_id = b.org_id
         where b.org_id = ${orgId}${subsidiaryReadFilterWithUnassigned(sql`p.subsidiary_id`, readCtx?.allowedSubsidiaryIds)}
         order by b.tax_year desc, p.display_name
         limit ${MAX_EXPORT_ROWS + 1}`)) as { rows: Record<string, CellValue>[] }
      // Sentinel read: refuse rather than truncate a complete-looking file.
      enforceExportRowLimit(result.rows, PAYROLL_OPENING_BALANCES_DESCRIPTOR.label)

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
      // Program bases pivot onto their parent row by (employee, year): the
      // export stays one row per carry-in, like the components above.
      const programRows = (await db.execute(sql`
        select employee_party_id, tax_year, program_key, insurable_ytd::text as amount
          from payroll_opening_program_bases
         where org_id = ${orgId}`)) as {
        rows: { employee_party_id: string; tax_year: number; program_key: string; amount: string }[]
      }
      const programsByEmployeeYear = new Map<string, Record<string, string>>()
      for (const row of programRows.rows) {
        const key = `${row.employee_party_id} ${row.tax_year}`
        const amounts = programsByEmployeeYear.get(key) ?? {}
        amounts[`${PROGRAM_PREFIX}${row.program_key}`] = row.amount
        programsByEmployeeYear.set(key, amounts)
      }
      const rows = result.rows.map((row) => {
        const rowId = String(row.__rowId ?? '')
        const rest = { ...row }
        delete rest.__rowId
        const employeeYear = `${String(rest.__employeeId ?? '')} ${String(rest.taxYear ?? '')}`
        delete rest.__employeeId
        const out: Record<string, CellValue> = { ...rest }
        for (const component of components) out[componentColumnKey(component)] = null
        for (const [key, value] of Object.entries(byRow.get(rowId) ?? {})) out[key] = value
        for (const program of programs) out[programColumnKey(program.programKey)] = null
        for (const [key, value] of Object.entries(programsByEmployeeYear.get(employeeYear) ?? {})) out[key] = value
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

      // Whole-input duplicate guard before any save: per-row saves bypass
      // the engine's batch guard, so every row sharing a resolved
      // (employee, tax year) key is refused. Scope runs first so a
      // restricted caller sees scope errors, never duplicate evidence
      // about a hidden employee; refusal is per-key (resource outcomes
      // are per-row, unlike the engine's all-or-nothing batch),
      // including identical repeats.
      const preflight: {
        employeeId: string | null
        employeeError: string | null
        taxYear: number | null
        taxError: string | null
        scopeError: string | null
      }[] = []
      for (const src of rows) {
        let taxYear: number | null = null
        let taxError: string | null = null
        try {
          taxYear = assertTaxYear(src.taxYear)
        } catch (error) {
          taxError = error instanceof Error ? error.message : 'write failed'
        }
        let employeeId: string | null = null
        let employeeError: string | null = null
        let scopeError: string | null = null
        if (taxError === null) {
          const employee = await resolveEmployee(ctx.orgId, src.employee)
          if ('error' in employee) employeeError = employee.error
          else employeeId = employee.id
        }
        if (taxError === null && employeeError === null && employeeId !== null) {
          scopeError = await employeeWriteScopeError(ctx.orgId, employeeId, ctx.allowedSubsidiaryIds)
        }
        preflight.push({ employeeId, employeeError, taxYear, taxError, scopeError })
      }
      const keyUses = new Map<string, number>()
      for (const p of preflight) {
        if (p.employeeId !== null && p.taxYear !== null && p.scopeError === null) {
          const key = `${p.employeeId} ${p.taxYear}`
          keyUses.set(key, (keyUses.get(key) ?? 0) + 1)
        }
      }
      const duplicated = new Set<number>()
      preflight.forEach((p, index) => {
        if (
          p.employeeId !== null && p.taxYear !== null && p.scopeError === null &&
          keyUses.get(`${p.employeeId} ${p.taxYear}`)! > 1
        ) {
          duplicated.add(index)
        }
      })
      for (const index of [...duplicated].sort((a, b) => a - b)) {
        const p = preflight[index]!
        outcome.failed++
        outcome.errors.push({
          row: index + 1,
          message: `employee "${String(rows[index]!.employee).trim()}" appears more than once in this load for tax year ${p.taxYear} — keep only one row per employee and tax year`,
          field: 'employee',
        })
      }

      for (let index = 0; index < rows.length; index++) {
        if (duplicated.has(index)) continue
        const rowNo = index + 1
        const src = rows[index]!
        const pre = preflight[index]!
        try {
          if (pre.taxError !== null) throw new Error(pre.taxError)
          if (pre.employeeError !== null || pre.employeeId === null) {
            outcome.failed++
            outcome.errors.push({ row: rowNo, message: pre.employeeError ?? 'employee is required', field: 'employee' })
            continue
          }
          const taxYear = pre.taxYear!
          const employeeId = pre.employeeId
          // Scope was decided in the preflight above, before the preview
          // reports anything: a restricted importer must not learn, even in
          // dry-run, that a hidden employee exists and would be
          // created/updated.
          if (pre.scopeError !== null) {
            outcome.failed++
            outcome.errors.push({ row: rowNo, message: pre.scopeError, field: 'employee' })
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
          const lock = lockCache.get(taxYear)!.get(employeeId)
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
          const programs = programAmountsFrom(src)
          const normalizedPrograms = programs === undefined
            ? {}
            : normalizeOpeningProgramBases(programs, await loadPrograms())
          const existed = existingCache.get(taxYear)!.has(employeeId)
          const empty = isEmptyOpeningBalance(amounts, normalizedComponents, normalizedPrograms)
          if (ctx.dryRun) {
            if (empty && !existed) {
              // A blank row with nothing stored writes nothing on commit
              // (the engine deletes nothing and counts nothing), so the
              // preview must not claim an update either. The advisory keeps
              // the row visible instead of silently vanishing from the
              // counts; the commit path below reports the same warning.
              if (!outcome.warnings) outcome.warnings = []
              outcome.warnings.push({ row: rowNo, message: NOTHING_TO_WRITE })
              continue
            }
            // An empty row against a STORED carry-in clears it: commit
            // deletes it (counted as an update below), so preview says
            // updated. That delete behavior and its audit are unchanged.
            if (existed) outcome.updated++
            else outcome.created++
            continue
          }

          const result = await saveOpeningBalances({
            orgId: ctx.orgId,
            actorId: ctx.actorId,
            taxYear,
            rows: [{ employeePartyId: employeeId, amounts: src, components, programs }],
            allowedSubsidiaryIds: ctx.allowedSubsidiaryIds ?? undefined,
          })
          outcome.created += result.created
          outcome.updated += result.updated + result.deleted
          if (result.created > 0) existingCache.get(taxYear)!.add(employeeId)
          if (result.deleted > 0) existingCache.get(taxYear)!.delete(employeeId)
          if (empty && !existed) {
            if (!outcome.warnings) outcome.warnings = []
            outcome.warnings.push({ row: rowNo, message: NOTHING_TO_WRITE })
          }
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
 * engine/src/payroll/entitlements.ts, so an import cannot bypass the sign check
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
  scopedWrite: true,
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
    async read(readCtx?: ReadCtx) {
      const resourceFields = entitlementFields(await loadPlans())
      const columns = resourceFields.map((f) => ({ key: f.key, label: f.label }))
      // Same identity-based employee scope as the balances read above.
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
         where l.org_id = ${orgId} and l.kind = 'opening'${subsidiaryReadFilterWithUnassigned(sql`p.subsidiary_id`, readCtx?.allowedSubsidiaryIds)}
         order by pl.code, p.display_name
         limit ${MAX_EXPORT_ROWS + 1}`)) as { rows: Record<string, CellValue>[] }
      // Sentinel read: refuse rather than truncate a complete-looking file.
      enforceExportRowLimit(result.rows, PAYROLL_OPENING_ENTITLEMENTS_DESCRIPTOR.label)
      return { fields: resourceFields, columns, rows: result.rows }
    },
    async write(rows, _mode, ctx: WriteCtx) {
      const outcome: WriteOutcome = { created: 0, updated: 0, failed: 0, errors: [] }
      const plans = await loadPlans()
      const planByCode = new Map(plans.map((plan) => [plan.code.trim().toLowerCase(), plan]))
      const locks = await entitlementOpeningLocks(ctx.orgId)

      for (let index = 0; index < rows.length; index++) {
        const rowNo = index + 1
        const src = rows[index]!
        try {
          const employee = await resolveEmployee(ctx.orgId, src.employee)
          if ('error' in employee) {
            outcome.failed++
            outcome.errors.push({ row: rowNo, message: employee.error, field: 'employee' })
            continue
          }
          // Scope is decided before the preview reports anything: a restricted
          // importer must not learn, even in dry-run, that a hidden employee
          // exists and would be created/updated.
          const scopeError = await employeeWriteScopeError(ctx.orgId, employee.id, ctx.allowedSubsidiaryIds)
          if (scopeError) {
            outcome.failed++
            outcome.errors.push({ row: rowNo, message: scopeError, field: 'employee' })
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
          //
          // The amount is parsed by the engine save path's own canonical
          // parser, on the RAW cell text: separators are refused with a
          // remedy, never stripped. Pre-normalizing here would reintroduce
          // the silent 100x revaluation the engine refuses, and the dry run
          // would report success for a load the real import then banks wrong.
          const amount = parseEntitlementCarryInAmount(src.amount, plan.code)
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
            rows: [{ employeePartyId: employee.id, amounts: { [plan.code]: amount } }],
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

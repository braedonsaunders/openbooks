import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import {
  assertTaxYear,
  declaredEmployerLevyFields,
  employerLevyOpeningsForYear,
  saveEmployerLevyOpening,
  type DeclaredEmployerLevyField,
} from '@openbooks/engine/src/payroll/opening-balances.ts'
import type { CellValue, ResourceDescriptor, ResourceField, WriteOutcome } from './types'
import type { DataResource, WriteCtx } from './resources'
import {
  enforceExportRowLimit,
  type ReadCtx,
} from './resource-core'

/**
 * Employer-side mid-year adoption carry-in as an import/export resource.
 *
 * The per-employee carry-ins have an import resource; the employer base
 * year-to-date had only the engine save with no caller, so a mid-year
 * adopter's employer levies silently restarted at zero. This is the bulk
 * path for that save — the same mapping wizard, dry-run preview and
 * parsers every other resource uses. Every write still goes through
 * engine/src/payroll/opening-balances.ts, so an import cannot bypass the
 * pack-declaration check or the refusal to restate room a committed run
 * already consumed.
 *
 * Levy kinds come from the packs (country-agnostic): the `levy` column names
 * a declared levy key (or its label), and `country` names the pack. A row
 * naming a levy nothing declares is refused, not shelved.
 */

export const PAYROLL_EMPLOYER_LEVY_OPENINGS_KEY = 'payroll-employer-levy-openings'

export const PAYROLL_EMPLOYER_LEVY_OPENINGS_DESCRIPTOR: ResourceDescriptor = {
  key: PAYROLL_EMPLOYER_LEVY_OPENINGS_KEY,
  label: 'Payroll employer levy openings',
  group: 'Setup',
  iconKey: 'history',
  readPermission: 'payroll.read',
  writePermission: 'payroll.manage',
  supportsImport: true,
  naturalKey: 'country + levy + region + taxYear',
}

function resourceFields(): ResourceField[] {
  return [
    { key: 'country', label: 'Country pack', kind: 'text', required: true },
    { key: 'levy', label: 'Levy (key or label)', kind: 'text', required: true },
    { key: 'region', label: 'Region (for region levies)', kind: 'text' },
    { key: 'taxYear', label: 'Tax year', kind: 'number', required: true },
    { key: 'baseYtd', label: 'Base year-to-date', kind: 'currency', required: true },
  ]
}

/** Resolve a file row's levy against the pack declarations for its year. */
function resolveLevy(
  country: string,
  levy: string,
  taxYear: number,
  declared: readonly DeclaredEmployerLevyField[],
): DeclaredEmployerLevyField | { error: string } {
  const wantCountry = country.trim()
  const want = levy.trim()
  const inCountry = declared.filter((field) => field.country === wantCountry)
  if (inCountry.length === 0) {
    return { error: `country "${wantCountry}" declares no employer levies for ${taxYear}` }
  }
  const match =
    inCountry.find((field) => field.levyKey === want) ??
    inCountry.find((field) => field.label === want)
  if (!match) {
    const offered = inCountry.map((field) => field.levyKey).join(', ')
    return { error: `levy "${want}" is not declared by the ${wantCountry} pack for ${taxYear} — declared: ${offered}` }
  }
  return match
}

export function payrollEmployerLevyOpeningsResource(orgId: string): DataResource {
  return {
    descriptor: PAYROLL_EMPLOYER_LEVY_OPENINGS_DESCRIPTOR,
    async fields() {
      return resourceFields()
    },
    async columns() {
      return resourceFields().map((f) => ({ key: f.key, label: f.label }))
    },
    async read(_readCtx?: ReadCtx) {
      // Employer carry-ins are org-level facts; no employee scope applies.
      const years = (await db.execute<{ tax_year: number }>(sql`
        select distinct tax_year from payroll_employer_levy_opening where org_id = ${orgId}`))
      const rows: Record<string, CellValue>[] = []
      for (const row of years.rows) {
        const taxYear = Number(row.tax_year)
        const declared = await declaredEmployerLevyFields(taxYear)
        const byKey = new Map(declared.map((field) => [`${field.country} ${field.levyKey}`, field]))
        const stored = await employerLevyOpeningsForYear(orgId, taxYear)
        for (const opening of stored) {
          const field = byKey.get(`${opening.country} ${opening.levyKey}`)
          rows.push({
            country: opening.country,
            levy: field?.label ?? opening.levyKey,
            region: opening.region,
            taxYear,
            baseYtd: opening.baseYtd,
          })
        }
      }
      rows.sort((a, b) =>
        Number(a.taxYear) - Number(b.taxYear) ||
        String(a.country).localeCompare(String(b.country)) ||
        String(a.levy).localeCompare(String(b.levy)),
      )
      enforceExportRowLimit(rows, PAYROLL_EMPLOYER_LEVY_OPENINGS_DESCRIPTOR.label)
      const fields = resourceFields()
      return { fields, columns: fields.map((f) => ({ key: f.key, label: f.label })), rows }
    },
    async write(rows, _mode, ctx: WriteCtx) {
      const outcome: WriteOutcome = { created: 0, updated: 0, failed: 0, errors: [] }
      // One strict save per row, like the sibling resources: the engine call
      // is all-or-nothing, and resource outcomes are per-row, so each row
      // stands or fails on its own with its own message.
      for (let index = 0; index < rows.length; index++) {
        const rowNo = index + 1
        const src = rows[index]!
        try {
          const taxYear = assertTaxYear(src.taxYear)
          const country = String(src.country ?? '').trim()
          if (!country) throw new Error('country is required')
          const levyCell = String(src.levy ?? '').trim()
          if (!levyCell) throw new Error('levy is required')
          const resolved = resolveLevy(country, levyCell, taxYear, await declaredEmployerLevyFields(taxYear))
          if ('error' in resolved) throw new Error(resolved.error)
          const regionRaw = String(src.region ?? '').trim()
          const region = regionRaw === '' ? null : regionRaw
          const baseYtd = src.baseYtd
          if (baseYtd == null || String(baseYtd).trim() === '') throw new Error('base year-to-date is required')
          if (ctx.dryRun) {
            outcome.created++
            continue
          }
          const result = await saveEmployerLevyOpening({
            orgId: ctx.orgId,
            actorId: ctx.actorId,
            taxYear,
            rows: [{
              country: resolved.country,
              levyKey: resolved.levyKey,
              region,
              baseYtd: String(baseYtd).trim(),
            }],
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

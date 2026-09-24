import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { cmp, normalizeMoney } from '@openbooks/engine/src/money/money.ts'
import {
  assertTaxYear,
  declaredEmployerLevyFields,
  employerLevyOpeningsForYear,
  saveEmployerLevyOpening,
  type DeclaredEmployerLevyField,
} from '@openbooks/engine/src/payroll/opening-balances.ts'
import type { CellValue, ImportMode, ResourceDescriptor, ResourceField, WriteOutcome } from './types'
import type { DataResource, WriteCtx } from './resources'
import {
  duplicateImportRowIndexes,
  enforceExportRowLimit,
  importRowAction,
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
    async write(rows, mode: ImportMode, ctx: WriteCtx) {
      const outcome: WriteOutcome = { created: 0, updated: 0, failed: 0, errors: [] }
      const existingByYear = new Map<number, Set<string>>()
      const prepared: ({
        taxYear: number
        country: string
        levyKey: string
        region: string | null
        baseYtd: string
        key: string
      } | { error: string })[] = []

      // Resolve and validate every row before writing: duplicate natural keys
      // must refuse every colliding row, not let input order choose the winner.
      for (let index = 0; index < rows.length; index++) {
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
          if (resolved.scope === 'region' && region === null) {
            throw new Error(`levy "${resolved.levyKey}" is assessed per region — name the region this history belongs to`)
          }
          if (resolved.scope === 'org' && region !== null) {
            throw new Error(`levy "${resolved.levyKey}" is employer-wide — it carries no region`)
          }
          const rawBase = String(src.baseYtd ?? '').trim()
          if (!rawBase) throw new Error('base year-to-date is required')
          const baseYtd = normalizeMoney(rawBase)
          if (cmp(baseYtd, '0') < 0) throw new Error('base is history already earned — never less than zero')
          const key = `${taxYear}\0${resolved.country}\0${resolved.levyKey}\0${region ?? ''}`
          if (!existingByYear.has(taxYear)) {
            const stored = await employerLevyOpeningsForYear(ctx.orgId, taxYear)
            existingByYear.set(taxYear, new Set(stored.map((opening) =>
              `${taxYear}\0${opening.country}\0${opening.levyKey}\0${opening.region ?? ''}`)))
          }
          prepared.push({ taxYear, country: resolved.country, levyKey: resolved.levyKey, region, baseYtd, key })
        } catch (error) {
          prepared.push({ error: error instanceof Error ? error.message : 'write failed' })
        }
      }

      const duplicates = duplicateImportRowIndexes(prepared.map((row) => 'error' in row ? null : row.key))
      for (const index of duplicates) {
        outcome.failed++
        outcome.errors.push({ row: index + 1, message: 'this employer levy carry-in appears more than once in this load — keep one row per country, levy, region, and tax year' })
      }

      for (let index = 0; index < prepared.length; index++) {
        const row = prepared[index]!
        if ('error' in row) {
          outcome.failed++
          outcome.errors.push({ row: index + 1, message: row.error })
          continue
        }
        if (duplicates.has(index)) continue
        const action = importRowAction(mode, existingByYear.get(row.taxYear)!.has(row.key))
        if (action === 'conflict') {
          outcome.failed++
          outcome.errors.push({ row: index + 1, message: 'this employer levy carry-in already exists — choose upsert to replace it' })
          continue
        }
        if (ctx.dryRun) {
          if (action === 'update') outcome.updated++
          else outcome.created++
          continue
        }
        try {
          const result = await saveEmployerLevyOpening({
            orgId: ctx.orgId,
            actorId: ctx.actorId,
            taxYear: row.taxYear,
            mode,
            rows: [{ country: row.country, levyKey: row.levyKey, region: row.region, baseYtd: row.baseYtd }],
          })
          outcome.created += result.created
          outcome.updated += result.updated + result.deleted
          if (result.created > 0) existingByYear.get(row.taxYear)!.add(row.key)
          if (result.deleted > 0) existingByYear.get(row.taxYear)!.delete(row.key)
        } catch (error) {
          outcome.failed++
          outcome.errors.push({ row: index + 1, message: error instanceof Error ? error.message : 'write failed' })
        }
      }
      return outcome
    },
  }
}

import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/platform/database'
import { declaredPayrollFilings } from '@openbooks/engine/src/payroll/filing-registry.ts'
import { declaredJurisdictions, installablePayrollPacks, payrollPack } from '@openbooks/engine/src/payroll/packs.ts'
import { installedPayrollCountries } from '@openbooks/engine/payroll/setup'
import type { SetupColumn, SetupDynamicOptionsSource, SetupEntity, SetupField, SetupFilter, SetupOption } from './types'

/**
 * Materialize registry-declared dynamic options (`optionsSource`) from the
 * runtime declarations they name. SERVER-ONLY — the setup registry itself is
 * pure so the client drawer can import it; this module reaches into the
 * engine's pack registry and is called by the server components
 * (SetupEntitySection, the generic setup page) before the entity descriptor
 * is handed to the client.
 *
 * Payroll filing accounts are the first consumer: their country and
 * program-type pickers offer exactly what the declared payroll packs file
 * under (statutory proper-noun labels carried on the declaration), so a
 * registered third pack's program types appear with no registry edit. The
 * statically declared options stay in the descriptor as the fallback for any
 * surface that renders without resolving.
 */

/** English region name for a pack country code ('CA' → 'Canada'). */
const regionName = (() => {
  const names = new Intl.DisplayNames(['en'], { type: 'region' })
  return (code: string): string => {
    try {
      return names.of(code) ?? code
    } catch {
      return code
    }
  }
})()

/** After-tax: the generic member of every pack's treatment list. */
const AFTER_TAX_OPTION: SetupOption = { value: 'none', labelKey: 'options.payTaxTreatment.none' }

function treatmentOption(key: string, labelKey: string | undefined, label: string): SetupOption {
  return labelKey ? { value: key, labelKey, label } : { value: key, label }
}

/** This pack's treatment picker list: after-tax plus its declared vocabulary. */
function packTreatmentOptions(country: string): SetupOption[] {
  const treatments = payrollPack(country).deductionTreatments
  return [
    AFTER_TAX_OPTION,
    ...treatments.map((treatment) => treatmentOption(treatment.key, treatment.labelKey, treatment.label)),
  ]
}

/** This pack's protection classes (blank is "no class": the percentage alone). */
function packProtectionClassOptions(country: string): SetupOption[] {
  return (payrollPack(country).protectionClasses ?? []).map((entry) => ({ value: entry.key, label: entry.label }))
}

function dynamicOptions(source: SetupDynamicOptionsSource, packs: PayrollPackChoice[]): SetupOption[] {
  switch (source) {
    case 'payroll-filing-countries':
      return declaredPayrollFilings().map((pack) => ({
        value: pack.country,
        label: regionName(pack.country),
      }))
    case 'payroll-filing-program-types': {
      const options = new Map<string, SetupOption>()
      for (const pack of declaredPayrollFilings()) {
        for (const programType of pack.programTypes) {
          if (!options.has(programType.key)) {
            options.set(programType.key, { value: programType.key, label: programType.label })
          }
        }
      }
      return [...options.values()]
    }
    case 'payroll-component-countries':
      return packs.map((pack) => ({
        value: pack.country,
        label: pack.name,
      }))
    case 'payroll-deduction-treatments': {
      // Flat fallback: the cross-pack union (after-tax first). The per-pack
      // lists ride `scopedOptions` (see resolveField below); the drawer and
      // the write path both scope through `setupFieldOptions`, so the union
      // only renders where no country is in scope.
      const seen = new Set<string>([AFTER_TAX_OPTION.value])
      const union: SetupOption[] = [AFTER_TAX_OPTION]
      for (const pack of packs) {
        for (const option of packTreatmentOptions(pack.country)) {
          if (!seen.has(option.value)) {
            seen.add(option.value)
            union.push(option)
          }
        }
      }
      return union
    }
    case 'payroll-protection-classes':
      // Flat fallback where no country is in scope: every installed pack's
      // classes, named with their pack — a class carries one country's law.
      return packs.flatMap((pack) => packProtectionClassOptions(pack.country)
        .map((option) => ({ ...option, label: `${pack.name}: ${option.label}` })))
    case 'payroll-contribution-programs': {
      // Type-ahead over the packs' declared contribution programs AND
      // employer-levy programs (the pay-component program exclusion picker).
      // Cross-pack union by key; the labels ride the declarations, exactly
      // as filing program types do above. Free entry covers the rest;
      // undeclared keys are inert.
      const seen = new Set<string>()
      const union: SetupOption[] = []
      for (const { country } of packs) {
        const pack = payrollPack(country)
        for (const program of [...(pack.contributionPrograms ?? []), ...(pack.employerLevyPrograms ?? [])]) {
          if (!seen.has(program.key)) {
            seen.add(program.key)
            union.push({ value: program.key, label: program.label })
          }
        }
      }
      return union
    }
    case 'payroll-holiday-jurisdictions':
      // Every declared statutory calendar key, named with its declaration.
      // Company closures file under the calendar they close, so a key the
      // static fallback predates (a German Land, a French overseas
      // collectivity) must still be fileable — and writable, since the write
      // path validates against this same resolved list.
      return declaredJurisdictions().map((jurisdiction) => ({
        value: jurisdiction.key,
        label: jurisdiction.name,
      }))
    case 'payroll-statutory-reporting-categories': {
      const options = new Map<string, SetupOption>()
      for (const pack of packs) {
        // The list projection carries (country, name) only — the declaration
        // itself is read off the pack, like the treatment picker above.
        for (const entry of payrollPack(pack.country).statutoryReportingCodes ?? []) {
          if (!options.has(entry.category)) {
            options.set(entry.category, { value: entry.category, label: `${pack.name}: ${entry.label}` })
          }
        }
      }
      return [...options.values()]
    }
  }
}

/** Sources whose choices depend on the component's country, with each pack's own list. */
const COUNTRY_SCOPED_SOURCES: Partial<Record<SetupDynamicOptionsSource, (country: string) => SetupOption[]>> = {
  'payroll-deduction-treatments': packTreatmentOptions,
  'payroll-protection-classes': packProtectionClassOptions,
}

/** Per-country option lists for a country-scoped field, keyed by pack country. */
function optionsByCountry(packs: PayrollPackChoice[], forCountry: (country: string) => SetupOption[]): Record<string, SetupOption[]> {
  return Object.fromEntries(packs.map((pack) => [pack.country, forCountry(pack.country)]))
}

type PayrollPackChoice = ReturnType<typeof installablePayrollPacks>[number]

/**
 * What the organization itself runs, for options that only make sense
 * against it. With no context every installable pack is offered (the
 * registry-wide fallback); with the org's installed payroll packs the
 * pickers offer only those, so a single-country employer is never asked
 * which country a pay code belongs to.
 */
export interface SetupOptionsContext {
  installedPayrollCountries?: readonly string[]
}

/** Dynamic sources whose choices are narrowed to the org's installed packs. */
const PAYROLL_PACK_SOURCES = new Set<SetupDynamicOptionsSource>([
  'payroll-component-countries',
  'payroll-deduction-treatments',
  'payroll-protection-classes',
  'payroll-contribution-programs',
  'payroll-statutory-reporting-categories',
])

/**
 * Read the org facts the entity's dynamic options depend on. Only entities
 * that declare a pack-scoped source pay for the lookup.
 */
export async function setupOptionsContext(orgId: string, entity: SetupEntity): Promise<SetupOptionsContext> {
  const needsPacks = [...entity.columns, ...entity.fields, ...(entity.filters ?? [])]
    .some((item) => item.optionsSource && PAYROLL_PACK_SOURCES.has(item.optionsSource))
  if (!needsPacks) return {}
  const row = (await db.execute<{ payroll: Record<string, unknown> | null }>(sql`
    select settings -> 'payroll' as payroll from orgs where id = ${orgId}
  `)).rows[0]
  return { installedPayrollCountries: await installedPayrollCountries(orgId, row?.payroll ?? {}) }
}

function packChoices(context: SetupOptionsContext): PayrollPackChoice[] {
  const all = installablePayrollPacks()
  const installed = context.installedPayrollCountries
  return installed ? all.filter((pack) => installed.includes(pack.country)) : all
}

/**
 * A country picker over at most one installed pack has nothing to choose:
 * the field hides (a blank country applies the component to every
 * employee, which on a one-pack employer is everyone) and the list drops
 * the column and filter that could only ever show one value.
 */
const singleCountry = (item: SetupField | SetupColumn | SetupFilter, context: SetupOptionsContext, packs: PayrollPackChoice[]): boolean =>
  item.optionsSource === 'payroll-component-countries' && context.installedPayrollCountries !== undefined && packs.length <= 1

/**
 * A treatment field resolves twice: the flat cross-pack union replaces
 * `options` (the fallback where no country is in scope), and the per-pack
 * lists ride `scopedOptions` so the drawer and the write path scope through
 * `setupFieldOptions`. The scope field comes from the descriptor contract —
 * this module only fills the pack side of it.
 */
const resolveField = (field: SetupField, packs: PayrollPackChoice[], context: SetupOptionsContext): SetupField => {
  const resolved: SetupField = field.optionsSource
    ? { ...field, options: dynamicOptions(field.optionsSource, packs) }
    : field
  if (singleCountry(field, context, packs)) return { ...resolved, hidden: true }
  const forCountry = field.optionsSource ? COUNTRY_SCOPED_SOURCES[field.optionsSource] : undefined
  if (!forCountry) return resolved
  return {
    ...resolved,
    scopedOptions: { scopeField: 'country', byValue: optionsByCountry(packs, forCountry) },
  }
}

/** The entity with every `optionsSource` materialized. Identity when none. */
export function resolveDynamicSetupOptions(entity: SetupEntity, context: SetupOptionsContext = {}): SetupEntity {
  const needsResolution = [
    ...entity.columns,
    ...entity.fields,
    ...(entity.filters ?? []),
  ].some((item) => item.optionsSource)
  if (!needsResolution) return entity
  const packs = packChoices(context)
  const resolve = <T extends SetupColumn | SetupFilter>(item: T): T =>
    item.optionsSource ? { ...item, options: dynamicOptions(item.optionsSource, packs) } : item
  return {
    ...entity,
    columns: entity.columns.filter((column) => !singleCountry(column, context, packs)).map(resolve),
    fields: entity.fields.map((field) => resolveField(field, packs, context)),
    filters: entity.filters?.filter((filter) => !singleCountry(filter, context, packs)).map(resolve),
  }
}

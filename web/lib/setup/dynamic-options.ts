import { declaredPayrollFilings } from '@openbooks/engine/src/payroll/filing-registry.ts'
import { installablePayrollPacks, payrollPack } from '@openbooks/engine/src/payroll/packs.ts'
import type { SetupColumn, SetupDynamicOptionsSource, SetupEntity, SetupField, SetupFilter, SetupOption } from './registry'

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

function dynamicOptions(source: SetupDynamicOptionsSource): SetupOption[] {
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
      return installablePayrollPacks().map((pack) => ({
        value: pack.country,
        label: pack.name,
      }))
    case 'payroll-deduction-treatments': {
      // Flat fallback: the cross-pack union (after-tax first). The per-pack
      // lists ride `scopedOptions` (see resolveField below); the drawer and
      // the write path both scope through `setupFieldOptions`, so the union
      // only renders where no country is in scope.
      const seen = new Set<string>()
      const union: SetupOption[] = []
      for (const pack of installablePayrollPacks()) {
        for (const option of packTreatmentOptions(pack.country)) {
          if (!seen.has(option.value)) {
            seen.add(option.value)
            union.push(option)
          }
        }
      }
      return union
    }
    case 'payroll-contribution-programs': {
      // Type-ahead over the packs' declared contribution programs (the
      // pay-component program exclusion picker). Cross-pack union by key;
      // the labels ride the declarations, exactly as filing program types
      // do above. Free entry covers the rest; undeclared keys are inert.
      const seen = new Set<string>()
      const union: SetupOption[] = []
      for (const { country } of installablePayrollPacks()) {
        for (const program of payrollPack(country).contributionPrograms ?? []) {
          if (!seen.has(program.key)) {
            seen.add(program.key)
            union.push({ value: program.key, label: program.label })
          }
        }
      }
      return union
    }
  }
}

/** Per-country treatment lists for a scoped treatment field, keyed by pack country. */
function deductionTreatmentsByCountry(): Record<string, SetupOption[]> {
  return Object.fromEntries(
    installablePayrollPacks().map((pack) => [pack.country, packTreatmentOptions(pack.country)]),
  )
}

const resolve = <T extends SetupField | SetupColumn | SetupFilter>(item: T): T =>
  item.optionsSource ? { ...item, options: dynamicOptions(item.optionsSource) } : item

/**
 * A treatment field resolves twice: the flat cross-pack union replaces
 * `options` (the fallback where no country is in scope), and the per-pack
 * lists ride `scopedOptions` so the drawer and the write path scope through
 * `setupFieldOptions`. The scope field comes from the descriptor contract —
 * this module only fills the pack side of it.
 */
const resolveField = (field: SetupField): SetupField => {
  const resolved = resolve(field)
  if (field.optionsSource !== 'payroll-deduction-treatments') return resolved
  return {
    ...resolved,
    scopedOptions: { scopeField: 'country', byValue: deductionTreatmentsByCountry() },
  }
}

/** The entity with every `optionsSource` materialized. Identity when none. */
export function resolveDynamicSetupOptions(entity: SetupEntity): SetupEntity {
  const needsResolution = [
    ...entity.columns,
    ...entity.fields,
    ...(entity.filters ?? []),
  ].some((item) => item.optionsSource)
  if (!needsResolution) return entity
  return {
    ...entity,
    columns: entity.columns.map(resolve),
    fields: entity.fields.map(resolveField),
    filters: entity.filters?.map(resolve),
  }
}

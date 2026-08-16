import { declaredPayrollFilings } from '@openbooks/engine/src/payroll-filing-registry.ts'
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
  }
}

const resolve = <T extends SetupField | SetupColumn | SetupFilter>(item: T): T =>
  item.optionsSource ? { ...item, options: dynamicOptions(item.optionsSource) } : item

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
    fields: entity.fields.map(resolve),
    filters: entity.filters?.map(resolve),
  }
}

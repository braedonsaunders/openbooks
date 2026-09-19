/**
 * A pack's component-treatment picker must name THAT pack's instruments.
 *
 * Observed: the new-component tax-treatment picker offered Canadian
 * treatments on non-Canadian components — "Pension (RPP/RRSP, factor F)",
 * "Union dues (U1)", "Alimony (F2)". The mechanism is the shared
 * `labelKey`: the US, GB and IE packs declare the Canadian catalog keys
 * (`options.payTaxTreatment.pensionF` et al), so even the fully RESOLVED
 * per-pack list renders another country's proper nouns. Values (keys) are
 * asserted in dynamic-options-agreement.test.ts; this asserts the LABELS a
 * person reads.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const { resolveDynamicSetupOptions } = (await import('./dynamic-options.ts')) as {
  resolveDynamicSetupOptions: (entity: unknown) => {
    fields?: {
      key: string
      scopedOptions?: {
        scopeField: string
        byValue: Record<string, { value: string; labelKey?: string; label?: string }[]>
      }
    }[]
  }
}
const { SETUP_ENTITY_BY_KEY } = (await import('./registry.ts')) as {
  SETUP_ENTITY_BY_KEY: Map<string, unknown>
}
const packRegistry: typeof import('@openbooks/engine/src/payroll/packs.ts') =
  await import('@openbooks/engine/src/payroll/packs.ts')

const MESSAGES = join(import.meta.dirname, '..', '..', 'messages', 'en', 'admin.json')

function catalogLabel(labelKey: string): string {
  const catalog = JSON.parse(readFileSync(MESSAGES, 'utf8')) as Record<string, unknown>
  const parts = ['admin', 'setup', 'options', ...labelKey.split('.').slice(1)]
  let node: unknown = catalog
  for (const part of parts.slice(1)) {
    if (typeof node !== 'object' || node === null) return labelKey
    node = (node as Record<string, unknown>)[part]
  }
  return typeof node === 'string' ? node : labelKey
}

// Canadian statutory proper nouns. A non-Canadian pack's treatment label must
// name its own instruments, never these.
const CANADIAN_MARKERS = /RPP|RRSP|T4127|factor F|\(U1\)|\bF2\b/

test('non-Canadian packs render their own treatment names, not Canadian factors', () => {
  const entity = resolveDynamicSetupOptions(SETUP_ENTITY_BY_KEY.get('pay-components'))
  const treatment = entity.fields?.find((field) => field.key === 'taxTreatment')
  assert.ok(treatment?.scopedOptions, 'taxTreatment resolves per-country lists')
  const failures: string[] = []
  for (const pack of packRegistry.installablePayrollPacks()) {
    if (pack.country === 'CA') continue
    for (const option of treatment.scopedOptions.byValue[pack.country] ?? []) {
      if (option.value === 'none') continue
      const rendered = option.labelKey ? catalogLabel(option.labelKey) : (option.label ?? option.value)
      if (CANADIAN_MARKERS.test(rendered)) {
        failures.push(`${pack.country}/${option.value} renders as ${JSON.stringify(rendered)}`)
      }
    }
  }
  assert.deepEqual(failures, [], 'packs render another country\u2019s treatment names')
})

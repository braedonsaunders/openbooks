/**
 * What the picker OFFERS and what the server ACCEPTS must be the same list.
 *
 * A persona created a German payroll filing account. The request carried a
 * correct `country: "DE"` — the DOM select held value=[DE] text=[Germany] — and
 * the server answered 400 "country has an invalid value". Canada with the same
 * program type returned 200.
 *
 * The cause was two lists for one field. A setup field may declare BOTH a
 * static `options` array and a dynamic `optionsSource`; per dynamic-options.ts
 * the static array is "the fallback for any surface that renders without
 * resolving". The RENDER path resolved and offered all fourteen declared
 * payroll countries. The WRITE path never resolved, so `coerceField`'s `select`
 * check validated against the fallback — still the CA/US pair from before the
 * pack registry opened. The picker offered fourteen countries and the server
 * accepted two.
 *
 * This is the same shape as the payroll account-type allow-list that had
 * drifted from the seeded charts, and the same Canada-as-default class as the
 * nine-digit identifier rule: a hardcoded list that stopped matching reality
 * with nothing comparing the two.
 *
 * These tests assert the RELATION rather than either list's contents, so they
 * keep holding as packs are added.
 */
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') {
      return { shortCircuit: true as const, url: 'data:text/javascript,export {}' }
    }
    return next(specifier, context)
  },
})

const { SETUP_ENTITIES } = (await import('./registry')) as {
  SETUP_ENTITIES: {
    key: string
    fields?: { key: string; kind?: string; options?: { value: string }[]; optionsSource?: string }[]
    columns?: { key: string; options?: { value: string }[]; optionsSource?: string }[]
  }[]
}
const { resolveDynamicSetupOptions } = (await import('./dynamic-options')) as {
  resolveDynamicSetupOptions: (entity: unknown) => {
    fields?: { key: string; options?: { value: string }[]; optionsSource?: string }[]
  }
}

/** Every field that declares a dynamic options source, with its entity. */
function dynamicFields(): { entity: string; field: string; staticValues: string[] }[] {
  const out: { entity: string; field: string; staticValues: string[] }[] = []
  for (const entity of SETUP_ENTITIES) {
    for (const field of entity.fields ?? []) {
      if (!field.optionsSource) continue
      out.push({
        entity: entity.key,
        field: field.key,
        staticValues: (field.options ?? []).map((option) => option.value),
      })
    }
  }
  return out
}

test('some field declares a dynamic options source, so these tests are not vacuous', () => {
  assert.ok(dynamicFields().length > 0, 'expected at least one field with optionsSource')
})

test('resolving an entity replaces the static fallback with the dynamic list', () => {
  for (const { entity: entityKey, field: fieldKey, staticValues } of dynamicFields()) {
    const entity = SETUP_ENTITIES.find((candidate) => candidate.key === entityKey)!
    const resolved = resolveDynamicSetupOptions(entity)
    const field = resolved.fields?.find((candidate) => candidate.key === fieldKey)
    assert.ok(field, `${entityKey}.${fieldKey} survives resolution`)
    const resolvedValues = (field.options ?? []).map((option) => option.value)
    assert.ok(
      resolvedValues.length > 0,
      `${entityKey}.${fieldKey} resolved to NO options — the picker would offer nothing`,
    )
    // The fallback must not be able to reject something the resolved list
    // offers. Equality is too strong (a fallback may legitimately be a subset),
    // but every resolved value must be acceptable, which is what the server
    // validates. That is the direction the defect ran.
    const unacceptable = resolvedValues.filter((value) => !resolvedValues.includes(value))
    assert.deepEqual(unacceptable, [], 'resolution must be self-consistent')
    assert.ok(
      staticValues.length === 0 || resolvedValues.length >= staticValues.length,
      `${entityKey}.${fieldKey}: the static fallback (${staticValues.join(', ')}) is WIDER than the `
      + `resolved list (${resolvedValues.join(', ')}), so the picker offers less than it accepts`,
    )
  }
})

test('every installable pack is writable as a pay-component country', async () => {
  // The component dialog's Country picker offered only Canada and the United
  // States though fourteen packs are installable. Every installable pack
  // must be acceptable to the write path, or its employees cannot have
  // country-scoped components at all.
  const { installablePayrollPacks } = (await import('@openbooks/engine/src/payroll/packs.ts')) as {
    installablePayrollPacks: () => { country: string }[]
  }
  const installable = installablePayrollPacks().map((pack) => pack.country)
  assert.ok(installable.length > 2, `expected more than the two built-ins, saw ${installable.join(', ')}`)

  const entity = SETUP_ENTITIES.find((candidate) => candidate.key === 'pay-components')
  assert.ok(entity, 'the pay-components entity exists')
  const resolved = resolveDynamicSetupOptions(entity)
  const country = resolved.fields?.find((field) => field.key === 'country')
  assert.ok(country, 'it has a country field')
  const accepted = (country.options ?? []).map((option) => option.value)

  const rejected = installable.filter((code) => !accepted.includes(code))
  assert.deepEqual(
    rejected,
    [],
    `these installable payroll packs cannot be written as a component country: ${rejected.join(', ')}`,
  )
})

test('every installable pack scopes its own treatment list, starting with after-tax', async () => {
  // The component dialog offered Canadian factor names for every country. A
  // pack's employees must see the treatments THAT pack declares — salary
  // sacrifice for AU, the T4127 factors for CA, after-tax only where the
  // pack transcribes no pre-tax treatment.
  const { installablePayrollPacks, payrollPack } = (await import('@openbooks/engine/src/payroll/packs.ts')) as unknown as {
    installablePayrollPacks: () => { country: string }[]
    payrollPack: (country: string) => { deductionTreatments: readonly { key: string }[] }
  }
  const entity = SETUP_ENTITIES.find((candidate) => candidate.key === 'pay-components')
  const resolved = resolveDynamicSetupOptions(entity)
  const treatment = resolved.fields?.find((field) => field.key === 'taxTreatment')
  assert.ok(treatment, 'it has a taxTreatment field')
  const scoped = (treatment as unknown as { scopedOptions?: { scopeField: string; byValue: Record<string, { value: string }[]> } }).scopedOptions
  assert.ok(scoped, 'the treatment field resolves per-country treatment lists')
  assert.equal(scoped.scopeField, 'country')
  for (const pack of installablePayrollPacks()) {
    const offered: string[] = (scoped.byValue[pack.country] ?? []).map((option) => option.value)
    const declared = ['none', ...payrollPack(pack.country).deductionTreatments.map((t) => t.key)]
    assert.deepEqual(offered, declared, `${pack.country} offers its own declared treatments`)
  }
})

test('the declared payroll packs are all writable as a filing-account country', async () => {
  // The persona's exact case. Every country the pack registry declares filings
  // for must be acceptable to the write path, or that country cannot have a
  // filing account created for it at all.
  const { declaredPayrollFilings } = (await import('@openbooks/engine/src/payroll-filing-registry.ts')) as {
    declaredPayrollFilings: () => { country: string }[]
  }
  const declared = declaredPayrollFilings().map((pack) => pack.country)
  assert.ok(declared.length > 2, `expected more than the two built-ins, saw ${declared.join(', ')}`)

  const entity = SETUP_ENTITIES.find((candidate) => candidate.key === 'payroll-filing-accounts')
  assert.ok(entity, 'the payroll-filing-accounts entity exists')
  const resolved = resolveDynamicSetupOptions(entity)
  const country = resolved.fields?.find((field) => field.key === 'country')
  assert.ok(country, 'it has a country field')
  const accepted = (country.options ?? []).map((option) => option.value)

  const rejected = declared.filter((code) => !accepted.includes(code))
  assert.deepEqual(
    rejected,
    [],
    `these declared payroll countries cannot be written as a filing-account country: ${rejected.join(', ')}`,
  )
})

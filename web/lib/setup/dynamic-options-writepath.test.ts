/**
 * The real write path must accept a country its own picker offers.
 *
 * dynamic-options-agreement.test.ts asserts the registry relation; this drives
 * `buildRow` — the function the setup POST route actually validates with — to
 * prove the German filing account a persona could not create now saves.
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

const { SETUP_ENTITY_BY_KEY } = (await import('./registry')) as {
  SETUP_ENTITY_BY_KEY: Map<string, unknown>
}
const { resolveDynamicSetupOptions } = (await import('./dynamic-options')) as {
  resolveDynamicSetupOptions: (entity: unknown, locale: string) => unknown
}
const { buildRow } = (await import('./coerce')) as {
  buildRow: (entity: unknown, body: Record<string, unknown>, opts: { forCreate: boolean })
    => { cols: unknown[] } | { error: string }
}

const GERMAN_ACCOUNT = {
  accountNumber: '913/1234/5678',
  name: 'Finanzamt ELSTER Arbeitgeber',
  country: 'DE',
  programType: 'de_finanzamt',
}

test('a German filing account is accepted once options are resolved', () => {
  const entity = resolveDynamicSetupOptions(SETUP_ENTITY_BY_KEY.get('payroll-filing-accounts'), 'en')
  const built = buildRow(entity, GERMAN_ACCOUNT, { forCreate: true })
  assert.ok(
    !('error' in built),
    `the write path rejected a country its own picker offers: ${'error' in built ? built.error : ''}`,
  )
})

test('even unresolved, the fallback no longer rejects a non-CA/US pack', () => {
  // This test used to PIN THE DEFECT: it asserted the unresolved entity
  // rejects DE, to document why resolveEntity must resolve. The fallback in
  // registry.ts now names every installable pack, so the defect it pinned
  // cannot recur and the assertion is inverted to guard the fix instead — a
  // regression to a CA/US-only fallback reddens here. Resolution is still
  // required, and is now guarded on its own terms by
  // dynamic-options-agreement.test.ts ('resolving an entity replaces the
  // static fallback with the dynamic list'), rather than by this test
  // keeping a bug alive to justify it.
  const built = buildRow(SETUP_ENTITY_BY_KEY.get('payroll-filing-accounts'), GERMAN_ACCOUNT, { forCreate: true })
  assert.ok(
    !('error' in built),
    `the unresolved fallback rejected DE, an installable pack: ${'error' in built ? built.error : ''}`,
  )
})

test('Canada still saves, so the fix did not widen validation into acceptance of anything', () => {
  const entity = resolveDynamicSetupOptions(SETUP_ENTITY_BY_KEY.get('payroll-filing-accounts'), 'en')
  const ok = buildRow(entity, { ...GERMAN_ACCOUNT, country: 'CA', programType: 'ca_rp' }, { forCreate: true })
  assert.ok(!('error' in ok))
  const bad = buildRow(entity, { ...GERMAN_ACCOUNT, country: 'ZZ' }, { forCreate: true })
  assert.ok('error' in bad, 'an undeclared country must still be refused')
})

const AU_SACRIFICE_COMPONENT = {
  code: 'SAL-SAC',
  name: 'Salary sacrifice',
  kind: 'deduction',
  country: 'AU',
  taxTreatment: 'salary_sacrifice',
}

test('an AU salary-sacrifice component is accepted once options are resolved', () => {
  const entity = resolveDynamicSetupOptions(SETUP_ENTITY_BY_KEY.get('pay-components'), 'en')
  const built = buildRow(entity, AU_SACRIFICE_COMPONENT, { forCreate: true })
  assert.ok(
    !('error' in built),
    `the write path rejected a treatment its own picker offers: ${'error' in built ? built.error : ''}`,
  )
})

test('a Canadian factor on an AU component is refused — strict when scoped', () => {
  const entity = resolveDynamicSetupOptions(SETUP_ENTITY_BY_KEY.get('pay-components'), 'en')
  const built = buildRow(entity, { ...AU_SACRIFICE_COMPONENT, taxTreatment: 'pension_f' }, { forCreate: true })
  assert.ok('error' in built, 'a treatment the component pack does not declare must be refused')
  assert.match((built as { error: string }).error, /taxTreatment has an invalid value/)
})

test('a shared (country-less) component accepts any declared treatment', () => {
  // No country in scope: the union applies, and the compute layer keys off
  // the employee's pack — so a foreign key is inert rather than wrong.
  const entity = resolveDynamicSetupOptions(SETUP_ENTITY_BY_KEY.get('pay-components'), 'en')
  const built = buildRow(entity, {
    code: 'SAL-SAC',
    name: 'Salary sacrifice',
    kind: 'deduction',
    taxTreatment: 'salary_sacrifice',
  }, { forCreate: true })
  assert.ok(!('error' in built))
})

test('the accept set is locale-invariant: labels localize, values do not', async () => {
  // Item 58 gives the resolver a locale so setup pickers name countries in
  // the operator's language. Validation (`coerceField`'s `select` check in
  // coerce.ts) compares `option.value`, never `label` — so a French operator
  // must be offered "Allemagne" where an English operator sees "Germany",
  // while both submit the same `country: "DE"` and are accepted alike. This
  // pins that parity on the real resolver across en and fr, with no doubles:
  // labels follow the single countryName helper per locale, the accepted
  // VALUES are identical, and buildRow accepts/refuses the same codes under
  // both.
  const { countryName } = (await import('../countries')) as {
    countryName: (code: string, locale: string) => string
  }
  type CountryField = { fields?: { key: string; options?: { value: string; label?: string }[] }[] }
  const base = SETUP_ENTITY_BY_KEY.get('payroll-filing-accounts')
  const en = resolveDynamicSetupOptions(base, 'en') as CountryField
  const fr = resolveDynamicSetupOptions(base, 'fr') as CountryField
  const countryOptions = (entity: CountryField) =>
    entity.fields?.find((field) => field.key === 'country')?.options ?? []
  const enOptions = countryOptions(en)
  const frOptions = countryOptions(fr)
  assert.ok(enOptions.length > 2, 'expected more than the two built-ins')
  for (const option of enOptions) {
    assert.equal(option.label, countryName(option.value, 'en'), `${option.value} renders its English name`)
  }
  for (const option of frOptions) {
    assert.equal(option.label, countryName(option.value, 'fr'), `${option.value} renders its French name`)
  }
  const deEn = enOptions.find((option) => option.value === 'DE')?.label
  const deFr = frOptions.find((option) => option.value === 'DE')?.label
  assert.equal(deEn, 'Germany')
  assert.equal(deFr, 'Allemagne')
  assert.notEqual(deEn, deFr, 'the locale must actually reach the label')
  assert.deepEqual(
    frOptions.map((option) => option.value).sort(),
    enOptions.map((option) => option.value).sort(),
    'the filing-country accept set must not depend on the operator language',
  )
  for (const [locale, entity] of [['en', en], ['fr', fr]] as const) {
    const german = buildRow(entity, GERMAN_ACCOUNT, { forCreate: true })
    assert.ok(!('error' in german), `DE accepted under ${locale}: ${'error' in german ? german.error : ''}`)
    const canadian = buildRow(entity, { ...GERMAN_ACCOUNT, country: 'CA', programType: 'ca_rp' }, { forCreate: true })
    assert.ok(!('error' in canadian), `CA accepted under ${locale}`)
    const bogus = buildRow(entity, { ...GERMAN_ACCOUNT, country: 'ZZ' }, { forCreate: true })
    assert.ok('error' in bogus, `an undeclared country must still be refused under ${locale}`)
  }
})

test('even unresolved, the component fallback no longer rejects a non-CA/US pack', () => {
  // Inverted for the same reason as the filing-account case above: the
  // fallback now names every installable pack AND every pack-declared
  // treatment, so AU's salary-sacrifice component is writable without
  // resolution. A regression to a CA/US-only fallback reddens here.
  const built = buildRow(SETUP_ENTITY_BY_KEY.get('pay-components'), AU_SACRIFICE_COMPONENT, { forCreate: true })
  assert.ok(
    !('error' in built),
    `the unresolved fallback rejected AU, an installable pack: ${'error' in built ? built.error : ''}`,
  )
})

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
  resolveDynamicSetupOptions: (entity: unknown) => unknown
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
  const entity = resolveDynamicSetupOptions(SETUP_ENTITY_BY_KEY.get('payroll-filing-accounts'))
  const built = buildRow(entity, GERMAN_ACCOUNT, { forCreate: true })
  assert.ok(
    !('error' in built),
    `the write path rejected a country its own picker offers: ${'error' in built ? built.error : ''}`,
  )
})

test('the unresolved entity is what rejected it — the defect, pinned', () => {
  // Kept deliberately: it documents WHY resolveEntity must resolve, so the
  // resolution cannot be removed as a redundant-looking call.
  const built = buildRow(SETUP_ENTITY_BY_KEY.get('payroll-filing-accounts'), GERMAN_ACCOUNT, { forCreate: true })
  assert.ok('error' in built, 'the static CA/US fallback is expected to reject DE')
  assert.match((built as { error: string }).error, /country has an invalid value/)
})

test('Canada still saves, so the fix did not widen validation into acceptance of anything', () => {
  const entity = resolveDynamicSetupOptions(SETUP_ENTITY_BY_KEY.get('payroll-filing-accounts'))
  const ok = buildRow(entity, { ...GERMAN_ACCOUNT, country: 'CA', programType: 'ca_rp' }, { forCreate: true })
  assert.ok(!('error' in ok))
  const bad = buildRow(entity, { ...GERMAN_ACCOUNT, country: 'ZZ' }, { forCreate: true })
  assert.ok('error' in bad, 'an undeclared country must still be refused')
})

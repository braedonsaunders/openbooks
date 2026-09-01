import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    return nextResolve(specifier, context)
  },
})

const { validateCustomValues } = await import('./custom-fields.ts')

const dateDef = {
  id: 'renewal-date',
  targetTable: 'parties',
  targetKind: null,
  key: 'renewalDate',
  label: 'Renewal date',
  fieldType: 'date' as const,
  config: {},
  isRequired: false,
  sortOrder: 0,
}

test('custom date fields reject impossible, malformed, and non-string values before cleaning', () => {
  for (const raw of [
    '2026-02-31',
    '2026-99-99',
    '2026-2-28',
    'not-a-date',
    new String('2026-02-28'),
    { toString: () => '2026-02-28' },
  ]) {
    const result = validateCustomValues([dateDef], { renewalDate: raw })
    assert.equal(result.ok, false, `${String(raw)} must be rejected`)
    assert.equal(result.cleaned.renewalDate, undefined, `${String(raw)} must not be cleaned for persistence`)
    assert.equal(result.errors.renewalDate, 'Renewal date must be a date')
  }
})

test('custom date fields preserve canonical valid YYYY-MM-DD values', () => {
  for (const raw of ['2026-02-28', '2024-02-29']) {
    const result = validateCustomValues([dateDef], { renewalDate: raw })
    assert.equal(result.ok, true)
    assert.deepEqual(result.cleaned, { renewalDate: raw })
  }
})

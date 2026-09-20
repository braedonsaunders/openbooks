import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { REPORT_ENTITY_MAP, bindPayStubIncomeTaxKeys } from './entities'
import { compileCustomQuery } from './custom-query'
import { validateCustomQuery } from './validate'
import { BUILT_IN_REPORT_DEFINITIONS } from './built-ins'

const payStubs = REPORT_ENTITY_MAP.pay_stubs!
const KEYS = ['fit', 'income_tax', 'pit', 'qc_income_tax', 'state_income_tax']

test('binder leaves the static catalog untouched and returns a full copy', () => {
  const before = payStubs.columns.map((c) => c.key)
  const bound = bindPayStubIncomeTaxKeys(payStubs, KEYS)
  assert.notEqual(bound, payStubs)
  // Same selectable surface: keys, labels, kinds and order all preserved.
  assert.deepEqual(
    bound.columns.map((c) => [c.key, c.label, c.kind]),
    payStubs.columns.map((c) => [c.key, c.label, c.kind]),
  )
  assert.deepEqual(bound.columns.map((c) => c.key), before)
  // Only the income_tax expression moves.
  for (const column of payStubs.columns) {
    const after = bound.columns.find((c) => c.key === column.key)!
    if (column.key === 'income_tax') assert.notEqual(after.expr, column.expr)
    else assert.equal(after.expr, column.expr)
  }
  // The static catalog still carries the legacy factor expression: the fix
  // flows through the binder, never through a second literal in this file.
  assert.match(payStubs.columns.find((c) => c.key === 'income_tax')!.expr, /factors->>'T'/)
  assert.doesNotMatch(bound.from, /factors->>'T'/)
})

test('bound income_tax aggregates stub lines by system key, not factors', () => {
  const bound = bindPayStubIncomeTaxKeys(payStubs, KEYS)
  assert.match(bound.from, /LEFT JOIN LATERAL/)
  assert.match(bound.from, /pay_stub_lines l/)
  assert.match(bound.from, /join pay_components c on c\.id = l\.component_id and c\.org_id = l\.org_id/)
  assert.match(bound.from, /where l\.org_id = s\.org_id and l\.stub_id = s\.id/)
  for (const key of KEYS) {
    assert.ok(bound.from.includes(`'${key}'`), `lateral join inlines ${key}`)
  }
  assert.equal(
    bound.columns.find((c) => c.key === 'income_tax')!.expr,
    'coalesce(income_tax_lines.tax, 0)',
  )
})

test('bound entity still validates and compiles the built-in payroll register', () => {
  const register = BUILT_IN_REPORT_DEFINITIONS.find((d) => d.slug === 'payroll-register')!
  const query = { ...register.query, entity: 'pay_stubs' }
  const bound = bindPayStubIncomeTaxKeys(payStubs, KEYS)
  const plan = validateCustomQuery(query, { pay_stubs: bound })
  const compiled = compileCustomQuery(bound, plan, '00000000-0000-0000-0000-000000000000', { maxRows: 100 })
  assert.match(compiled.text, /income_tax_lines/)
  for (const key of KEYS) assert.ok(compiled.text.includes(`'${key}'`))
  // The legacy compilation carries no line aggregation at all.
  const legacy = compileCustomQuery(payStubs, validateCustomQuery(query, REPORT_ENTITY_MAP), '00000000-0000-0000-0000-000000000000', { maxRows: 100 })
  assert.doesNotMatch(legacy.text, /income_tax_lines/)
  assert.doesNotMatch(legacy.text, /pay_stub_lines/)
})

test('binder refuses every silent-drop shape', () => {
  assert.throws(() => bindPayStubIncomeTaxKeys(REPORT_ENTITY_MAP.pay_stub_lines!, KEYS), /pay_stubs/)
  assert.throws(() => bindPayStubIncomeTaxKeys(payStubs, []), /non-empty/)
  assert.throws(() => bindPayStubIncomeTaxKeys(payStubs, ['pit', `x' OR '1'='1`]), /non-literal/)
  assert.throws(() => bindPayStubIncomeTaxKeys(payStubs, ['PIT']), /non-literal/)
  assert.throws(
    () => bindPayStubIncomeTaxKeys({ ...payStubs, columns: payStubs.columns.filter((c) => c.key !== 'income_tax') }, KEYS),
    /income_tax/,
  )
})

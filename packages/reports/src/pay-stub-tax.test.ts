import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { REPORT_ENTITY_MAP, bindPayStubIncomeTaxKeys, bindPayStubSocialKeys } from './entities'
import { compileCustomQuery } from './custom-query'
import { validateCustomQuery } from './validate'
import { BUILT_IN_REPORT_DEFINITIONS } from './built-ins'

const payStubs = REPORT_ENTITY_MAP.pay_stubs!
const KEYS = ['fit', 'income_tax', 'pit', 'qc_income_tax', 'state_income_tax']
// The register's EI rule (see eiColumnSystemKeys in the engine): legacy
// continuity plus the QPIP fold. The cpp_fica side is the structural
// complement of these inside the full set — computed, never enumerated.
const EI_KEYS = ['ei', 'qpip']
const SOCIAL_KEYS = ['cpp', 'cpp2', 'ei', 'qpip', 'ss', 'medicare', 'medicare_addl', 'zus_emeryt', 'nic']

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
  // Employee deductions only: employer shares posted under a shared key
  // must never join the withholding total.
  assert.match(bound.from, /and l\.kind = 'deduction'/)
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
  // Production resolves period_preset to concrete bounds before compiling
  // (prepareReportExecution); the compiler throws on an unresolved preset
  // rather than silently dropping the date window, so compile the resolved
  // shape here.
  const query = {
    ...register.query,
    entity: 'pay_stubs',
    filters: {
      combinator: 'and' as const,
      rules: [
        { field: 'pay_date', op: 'gte' as const, value: '2026-01-01' },
        { field: 'pay_date', op: 'lte' as const, value: '2026-12-31' },
      ],
    },
  }
  // The shipped shape: income and social binders composed, exactly as the
  // catalog does. Columns and labels are unchanged — only expressions move.
  const bound = bindPayStubSocialKeys(bindPayStubIncomeTaxKeys(payStubs, KEYS), EI_KEYS, SOCIAL_KEYS)
  const plan = validateCustomQuery(query, { pay_stubs: bound })
  assert.deepEqual(plan.columns, query.columns, 'every register column survives validation')
  const compiled = compileCustomQuery(bound, plan, '00000000-0000-0000-0000-000000000000', { maxRows: 100 })
  assert.match(compiled.text, /income_tax_lines/)
  assert.match(compiled.text, /cpp_fica_lines/)
  assert.match(compiled.text, /ei_lines/)
  for (const key of KEYS) assert.ok(compiled.text.includes(`'${key}'`))
  for (const key of SOCIAL_KEYS) assert.ok(compiled.text.includes(`'${key}'`))
  // The legacy compilation carries no line aggregation at all.
  const legacy = compileCustomQuery(payStubs, validateCustomQuery(query, REPORT_ENTITY_MAP), '00000000-0000-0000-0000-000000000000', { maxRows: 100 })
  assert.doesNotMatch(legacy.text, /income_tax_lines/)
  assert.doesNotMatch(legacy.text, /cpp_fica_lines/)
  assert.doesNotMatch(legacy.text, /ei_lines/)
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

test('social binder rebinds both buckets with columns and labels untouched', () => {
  const bound = bindPayStubSocialKeys(payStubs, EI_KEYS, SOCIAL_KEYS)
  assert.notEqual(bound, payStubs)
  // Same selectable surface: keys, labels, kinds and order all preserved —
  // the owner ruling keeps both columns and both labels, so the binder must
  // not add, remove, rename or relabel anything.
  assert.deepEqual(
    bound.columns.map((c) => [c.key, c.label, c.kind]),
    payStubs.columns.map((c) => [c.key, c.label, c.kind]),
  )
  // Only the two bucket expressions move.
  for (const column of payStubs.columns) {
    const after = bound.columns.find((c) => c.key === column.key)!
    if (column.key === 'cpp_fica') {
      assert.notEqual(after.expr, column.expr)
      assert.equal(after.expr, 'coalesce(cpp_fica_lines.total, 0)')
    } else if (column.key === 'ei') {
      assert.notEqual(after.expr, column.expr)
      assert.equal(after.expr, 'coalesce(ei_lines.total, 0)')
    } else assert.equal(after.expr, column.expr)
  }
  // The static catalog still carries the legacy factor expressions: the fix
  // flows through the binder, never through a second literal here.
  assert.match(payStubs.columns.find((c) => c.key === 'cpp_fica')!.expr, /factors->>'C'/)
  assert.match(payStubs.columns.find((c) => c.key === 'ei')!.expr, /factors->>'EI'/)
  assert.doesNotMatch(bound.from, /factors->>'EI'/)
})

test('social binder splits the derived set by complement, not by enumeration', () => {
  const bound = bindPayStubSocialKeys(payStubs, EI_KEYS, SOCIAL_KEYS)
  assert.match(bound.from, /LEFT JOIN LATERAL/)
  assert.match(bound.from, /\) cpp_fica_lines on true/)
  assert.match(bound.from, /\) ei_lines on true/)
  // Employee deductions only, on both joins.
  assert.equal(bound.from.match(/and l\.kind = 'deduction'/g)?.length, 2)
  // The EI join names exactly the stated pair — QPIP rides it because the
  // rule says so, which is the fold this change exists to ship.
  const eiJoin = bound.from.slice(bound.from.indexOf(') ei_lines on true') - 1200)
  for (const key of EI_KEYS) assert.ok(eiJoin.includes(`'${key}'`), `ei join inlines ${key}`)
  // The cpp_fica join names every other derived key and neither EI key: the
  // complement is computed by subtraction, so a key added to the derived
  // set later is counted without a second edit.
  const cppJoin = bound.from.slice(0, bound.from.indexOf(') cpp_fica_lines on true'))
  for (const key of SOCIAL_KEYS) {
    if (EI_KEYS.includes(key)) assert.ok(!cppJoin.includes(`'${key}'`), `cpp_fica join excludes ${key}`)
    else assert.ok(cppJoin.includes(`'${key}'`), `cpp_fica join inlines ${key}`)
  }
})

test('social binder refuses every silent-drop shape', () => {
  assert.throws(() => bindPayStubSocialKeys(REPORT_ENTITY_MAP.pay_stub_lines!, EI_KEYS, SOCIAL_KEYS), /pay_stubs/)
  assert.throws(() => bindPayStubSocialKeys(payStubs, EI_KEYS, []), /non-empty/)
  assert.throws(() => bindPayStubSocialKeys(payStubs, [], SOCIAL_KEYS), /non-empty/)
  assert.throws(() => bindPayStubSocialKeys(payStubs, EI_KEYS, ['ei', 'qpip', 'cpp', `x' OR '1'='1`]), /non-literal/)
  assert.throws(() => bindPayStubSocialKeys(payStubs, EI_KEYS, ['ei', 'qpip', 'CPP']), /non-literal/)
  assert.throws(
    () => bindPayStubSocialKeys({ ...payStubs, columns: payStubs.columns.filter((c) => c.key !== 'cpp_fica') }, EI_KEYS, SOCIAL_KEYS),
    /cpp_fica/,
  )
  assert.throws(
    () => bindPayStubSocialKeys({ ...payStubs, columns: payStubs.columns.filter((c) => c.key !== 'ei') }, EI_KEYS, SOCIAL_KEYS),
    /ei/,
  )
  // An EI key outside the derived set would invent money the declarations
  // never put in the bucket: refuse it rather than count it.
  assert.throws(() => bindPayStubSocialKeys(payStubs, ['ei', 'qpip', 'stray'], SOCIAL_KEYS), /outside the derived set/)
  assert.throws(() => bindPayStubSocialKeys(payStubs, ['ei', 'fit'], SOCIAL_KEYS), /outside the derived set/)
  // A double bind would stack a second aggregation over the same lines.
  const once = bindPayStubSocialKeys(payStubs, EI_KEYS, SOCIAL_KEYS)
  assert.throws(() => bindPayStubSocialKeys(once, EI_KEYS, SOCIAL_KEYS), /already applied/)
})

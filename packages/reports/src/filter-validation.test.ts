import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { REPORT_ENTITY_MAP } from './entities'
import { compileRuleGroup, SqlParams } from './filters'
import { validateCustomQuery } from './validate'

const documents = REPORT_ENTITY_MAP.documents!

function plan(filters: unknown) {
  return {
    entity: documents.key,
    mode: 'rows' as const,
    columns: ['document_number'],
    filters,
  }
}

test('an empty-valued eq rule is refused at save by field and operator name', () => {
  assert.throws(
    () => validateCustomQuery(plan({ combinator: 'and', rules: [{ field: 'status', op: 'eq', value: '' }] })),
    (error: unknown) => {
      const message = (error as Error).message
      return message.includes('status') && message.includes('eq')
    },
  )
})

test('an empty-valued rule never compiles to an unfiltered report', () => {
  const query = validateCustomQuery(
    plan({ combinator: 'and', rules: [{ field: 'status', op: 'eq', value: 'posted' }] }),
  )
  const compiled = compileRuleGroup(documents, query.filters!, new SqlParams())
  assert.match(compiled!, /status/i)
})

test('a NOT group with an uncompilable leg throws instead of inverting the remainder', () => {
  assert.throws(
    () =>
      compileRuleGroup(
        documents,
        {
          combinator: 'and',
          not: true,
          rules: [
            { field: 'status', op: 'eq', value: 'posted' },
            { field: 'no_such_column', op: 'eq', value: 'x' },
          ],
        },
        new SqlParams(),
      ),
    /no_such_column/,
  )
})

test('a single bad leg throws instead of running the report unfiltered', () => {
  assert.throws(
    () =>
      compileRuleGroup(
        documents,
        { combinator: 'and', rules: [{ field: 'no_such_column', op: 'eq', value: 'x' }] },
        new SqlParams(),
      ),
    /no_such_column/,
  )
})

test('a mixed-type in-filter is refused by field and operator name', () => {
  assert.throws(
    () => validateCustomQuery(plan({ combinator: 'and', rules: [{ field: 'status', op: 'in', value: ['posted', 1] }] })),
    (error: unknown) => {
      const message = (error as Error).message
      return message.includes('status') && message.includes('in') && message.includes('one type')
    },
  )
})

test('a non-scalar in-filter value is refused instead of narrowing silently', () => {
  assert.throws(
    () => validateCustomQuery(plan({ combinator: 'and', rules: [{ field: 'status', op: 'not_in', value: ['posted', null] }] })),
    (error: unknown) => {
      const message = (error as Error).message
      return message.includes('status') && message.includes('not_in')
    },
  )
})

test('homogeneous in-filter arrays still validate and compile', () => {
  const query = validateCustomQuery(
    plan({ combinator: 'and', rules: [{ field: 'status', op: 'in', value: ['posted', 'approved'] }] }),
  )
  const compiled = compileRuleGroup(documents, query.filters!, new SqlParams())
  assert.match(compiled!, /IN/)
})

test('value-less operators and real values still validate and compile', () => {
  const query = validateCustomQuery(
    plan({
      combinator: 'and',
      rules: [
        { field: 'status', op: 'is_not_null' },
        { field: 'status', op: 'eq', value: 'posted' },
      ],
    }),
  )
  const compiled = compileRuleGroup(documents, query.filters!, new SqlParams())
  assert.match(compiled!, /IS NOT NULL/)
  assert.match(compiled!, /=/)
})

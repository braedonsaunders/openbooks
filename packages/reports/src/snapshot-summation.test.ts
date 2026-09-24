import assert from 'node:assert/strict'
import test from 'node:test'
import { REPORT_ENTITY_MAP } from './entities'
import { compileCustomQuery } from './custom-query'

const ORG = '00000000-0000-4000-8000-000000000001'
const STUBS = REPORT_ENTITY_MAP.pay_stub_lines!

function summarize(measures: { fn: 'sum' | 'latest'; column: string }[]) {
  return compileCustomQuery(
    STUBS,
    {
      entity: 'pay_stub_lines',
      mode: 'summarize',
      columns: [],
      breakouts: [{ column: 'component' }],
      measures,
    },
    ORG,
    {},
  )
}

test('sum of the YTD snapshot refuses instead of counting every stub many times over', () => {
  // Each stub row already carries its component's year-to-date total, so a
  // SUM over stubs multiplies every movement by the number of later stubs
  // (~12x on monthly payroll). The refusal must name the column and the
  // honest aggregate.
  assert.throws(
    () => summarize([{ fn: 'sum', column: 'ytd_amount' }]),
    /ytd_amount.*snapshot.*latest|snapshot.*ytd_amount.*latest/,
  )
})

test('latest of the YTD snapshot compiles to the end value', () => {
  const compiled = summarize([{ fn: 'latest', column: 'ytd_amount' }])
  assert.match(compiled.text, /ARRAY_AGG/)
})

test('sum of the additive line amount still compiles', () => {
  const compiled = summarize([{ fn: 'sum', column: 'amount' }])
  assert.match(compiled.text, /SUM\(/)
})

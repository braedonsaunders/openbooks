import assert from 'node:assert/strict'
import test from 'node:test'
import { REPORT_ENTITY_MAP } from './entities'
import { compileCustomQuery } from './custom-query'
import { runCustomQuery, type PgQueryable } from './run'

const ORG = '00000000-0000-4000-8000-000000000001'
const LEDGER = REPORT_ENTITY_MAP.ledger_lines!

function summarize(bin: string, fiscalStartMonth?: number) {
  return compileCustomQuery(
    LEDGER,
    {
      entity: 'ledger_lines',
      mode: 'summarize',
      columns: [],
      breakouts: [{ column: 'posting_date', bin }],
      measures: [{ fn: 'count' }],
    },
    ORG,
    fiscalStartMonth === undefined ? {} : { fiscalStartMonth },
  )
}

test('fiscal_period shifts with the org start month like quarter and year do', () => {
  const july = summarize('fiscal_period', 7)
  assert.match(july.text, /interval '6 months'/, 'a July-start fiscal period must shift by 6 months')
  const january = summarize('fiscal_period', 1)
  assert.doesNotMatch(january.text, /interval/, 'a January-start org needs no shift')
  const missing = summarize('fiscal_period')
  assert.match(missing.text, /date_trunc\('month'/, 'an absent start month defaults to calendar months')
})

test('fiscal quarter and year keep their shift', () => {
  assert.match(summarize('fiscal_quarter', 7).text, /interval '6 months'/)
  assert.match(summarize('fiscal_year', 7).text, /interval '6 months'/)
})

test('fiscal bucket labels include their fiscal year and period number', async () => {
  const client: PgQueryable = {
    async query() {
      return { rows: [{ d0: '2026-07-01T00:00:00.000Z', m0: 1 }] }
    },
  }
  const labels = async (bin: 'fiscal_period' | 'fiscal_quarter' | 'fiscal_year') => {
    const result = await runCustomQuery(client, {
      entity: 'ledger_lines',
      mode: 'summarize',
      columns: [],
      breakouts: [{ column: 'posting_date', bin }],
      measures: [{ fn: 'count' }],
    }, {
      orgId: ORG,
      entityMap: REPORT_ENTITY_MAP,
      fiscalStartMonth: 7,
    })
    return result.groups.flatMap((group) => group.rows)[0]?.[0]
  }

  assert.equal(await labels('fiscal_period'), 'P1 FY 2027')
  assert.equal(await labels('fiscal_quarter'), 'Q1 FY 2027')
  assert.equal(await labels('fiscal_year'), 'FY 2027')
})

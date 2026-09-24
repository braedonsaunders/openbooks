import assert from 'node:assert/strict'
import test from 'node:test'
import { resolvePeriodPresetLeaves } from './period-presets'
import type { ReportCustomQuery } from './types'

const seen: string[] = []

async function stubRange(presetId: string): Promise<{ from: string; to: string }> {
  seen.push(presetId)
  if (presetId === 'this_fiscal_year') return { from: '2026-01-01', to: '2026-12-31' }
  throw new Error(`preset '${presetId}' no longer exists`)
}

function plan(): ReportCustomQuery {
  return {
    entity: 'documents',
    mode: 'rows',
    columns: ['document_number'],
    filters: {
      combinator: 'and',
      rules: [
        { field: 'posting_date', op: 'period_preset', value: 'this_fiscal_year' },
        { field: 'status', op: 'eq', value: 'posted' },
      ],
    },
  }
}

test('period_preset leaves rewrite to concrete gte/lte bounds on the same field', async () => {
  seen.length = 0
  const resolved = await resolvePeriodPresetLeaves(plan(), stubRange)
  assert.deepEqual(resolved.filters, {
    combinator: 'and',
    rules: [
      {
        combinator: 'and',
        rules: [
          { field: 'posting_date', op: 'gte', value: '2026-01-01' },
          { field: 'posting_date', op: 'lte', value: '2026-12-31' },
        ],
      },
      { field: 'status', op: 'eq', value: 'posted' },
    ],
  })
  assert.deepEqual(seen, ['this_fiscal_year'])
})

test('nested groups resolve while every other leaf passes through untouched', async () => {
  seen.length = 0
  const query: ReportCustomQuery = {
    entity: 'documents',
    mode: 'rows',
    columns: [],
    filters: {
      combinator: 'or',
      not: true,
      rules: [
        {
          combinator: 'and',
          rules: [{ field: 'posting_date', op: 'period_preset', value: 'this_fiscal_year' }],
        },
      ],
    },
  }
  const resolved = await resolvePeriodPresetLeaves(query, stubRange)
  assert.equal(resolved.filters?.combinator, 'or')
  assert.equal(resolved.filters?.not, true)
  const group = resolved.filters?.rules[0] as unknown as { rules: unknown[] }
  assert.equal((group.rules[0] as { combinator: string }).combinator, 'and')
})

test('a plan without preset leaves returns identically', async () => {
  seen.length = 0
  const query: ReportCustomQuery = {
    entity: 'documents',
    mode: 'rows',
    columns: [],
    filters: { combinator: 'and', rules: [{ field: 'status', op: 'eq', value: 'posted' }] },
  }
  const resolved = await resolvePeriodPresetLeaves(query, stubRange)
  assert.equal(resolved, query)
  assert.deepEqual(seen, [])
})

test('an unresolvable preset rejects instead of dropping the date bounds', async () => {
  const query: ReportCustomQuery = {
    entity: 'documents',
    mode: 'rows',
    columns: [],
    filters: {
      combinator: 'and',
      rules: [{ field: 'posting_date', op: 'period_preset', value: 'fiscal_yesterdecade' }],
    },
  }
  await assert.rejects(() => resolvePeriodPresetLeaves(query, stubRange), /fiscal_yesterdecade/)
})

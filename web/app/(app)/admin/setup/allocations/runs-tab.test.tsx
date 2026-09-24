import assert from 'node:assert/strict'
import test from 'node:test'

const React = await import('react')
Object.assign(globalThis, { React })
const { renderToStaticMarkup } = await import('react-dom/server')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../../messages/en')).default
const { ComputationView } = await import('./runs-tab')
const emptyCopy = (await import('../../../../../messages/en/allocations.json', { with: { type: 'json' } })).default.runs
  .computationEmpty as string

import type { Computation } from './runs-tab'

function render(computation: Computation): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <ComputationView computation={computation} />
    </NextIntlClientProvider>,
  )
}

const BASE: Computation = {
  ruleId: 'rule-1',
  versionId: 'ver-1',
  definitionHash: 'hash-1',
  periodId: 'per-1',
  bookId: 'book-1',
  sourceMeasure: 'period_activity',
  sources: [{ amount: '100.0000', lineCount: 2, accountId: 'acc-1234567890' }],
  sourceTotal: '100.0000',
  driver: null,
  targets: [
    { key: 'dept-eng-001', weight: '1', share: '10.0000', amount: '250.5000', residual: '0', label: null },
  ],
  lines: [],
  residualPolicy: 'largest_share',
  impact: 'reclass',
}

test('the computation preview lists sources and target shares with exact amounts', () => {
  const html = render(BASE)
  // Compact ids (first 8 chars) with the exact decimal text, never floats.
  assert.ok(html.includes('acc-1234'), 'the source account renders shortened')
  assert.ok(html.includes('100.0000'), 'the exact source amount renders')
  assert.ok(html.includes('dept-eng'), 'the target renders shortened')
  assert.ok(html.includes('10.0000'), 'the target share renders')
  assert.ok(html.includes('250.5000'), 'the target amount renders')
  // No driver configured: no driver section, and no lines section either.
  assert.ok(!html.includes('3.50'), 'no driver vector renders without a driver')
})

test('the driver vector renders when present and empty sources explain instead', () => {
  const html = render({
    ...BASE,
    sources: [],
    driver: { id: 'drv-1', key: 'headcount', vector: [{ key: 'eng-001', value: '3.50' }] },
  })
  assert.ok(html.includes('3.50'), 'the driver weight renders')
  assert.ok(html.includes('eng-001'), 'the driver target key renders')
  assert.ok(html.includes(emptyCopy), 'empty sources render the empty copy, never a bare table')
})

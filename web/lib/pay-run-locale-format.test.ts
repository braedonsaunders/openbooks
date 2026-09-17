import assert from 'node:assert/strict'
import test from 'node:test'
import { dateTime } from './format.ts'
import { createMoneyFormatter } from './money-format.ts'

// F-t04-014: pay-run list CREADO timestamps render English long-date in fr/es.
test('dateTime follows the request locale instead of hard-coded English', () => {
  const fr = dateTime('2026-09-16T22:51:00Z', 'fr')
  const es = dateTime('2026-09-16T22:51:00Z', 'es')
  assert.match(fr, /sept/i)
  assert.doesNotMatch(fr, /Sep 16, 2026/)
  assert.doesNotMatch(es, /Sep 16, 2026/)
})

// F-t04-014: es small totals render "2000,00 US$" next to grouped "20.077,63 US$".
test('es run totals group small amounts consistently with large ones', () => {
  const fmt = createMoneyFormatter('es', 'USD')
  assert.equal(fmt.money(2000, { useGrouping: 'always' }), '2.000,00 US$')
  assert.equal(fmt.money(20077.63, { useGrouping: 'always' }), '20.077,63 US$')
})

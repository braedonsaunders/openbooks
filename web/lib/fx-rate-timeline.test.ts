import assert from 'node:assert/strict'
import test from 'node:test'
import { flowRateOnOrBefore } from './fx-presentation'
import { civilDayIndex, isoFromCivilDayIndex } from '@openbooks/engine/platform/civil-date'

test('dated lookup preserves the latest covered quote and refuses a date preceding all history', () => {
  const rates = [{ asOf: '2026-07-31', rate: '1.2345678901' }, { asOf: '2026-07-15', rate: '1.1000000001' }, { asOf: '2026-07-01', rate: '0.9000000001' }]
  assert.equal(flowRateOnOrBefore(rates, '2026-08-01'), rates[0]!.rate)
  assert.equal(flowRateOnOrBefore(rates, '2026-07-31'), rates[0]!.rate)
  assert.equal(flowRateOnOrBefore(rates, '2026-07-30'), rates[1]!.rate)
  assert.equal(flowRateOnOrBefore(rates, '2026-07-01'), rates[2]!.rate)
  assert.equal(flowRateOnOrBefore(rates, '2026-06-30'), undefined)
  assert.equal(flowRateOnOrBefore([], '2026-07-31'), undefined)
})

test('a million quote history is searched logarithmically without losing exact rate strings', () => {
  let visited = 0
  const entries = 1_000_000
  const firstDay = civilDayIndex('2000-01-01')
  const rates = new Proxy([] as { asOf: string; rate: string }[], {
    get(target, key, receiver) {
      if (key === 'length') return entries
      if (typeof key === 'string' && /^\d+$/.test(key)) {
        visited++
        const value = entries - Number(key)
        return { asOf: isoFromCivilDayIndex(firstDay + value), rate: `1.${String(value).padStart(10, '0')}` }
      }
      return Reflect.get(target, key, receiver)
    },
  })
  assert.equal(flowRateOnOrBefore(rates, isoFromCivilDayIndex(firstDay + 500_000)), '1.0000500000')
  assert.ok(visited <= 22, `dated lookup read ${visited} quotes; binary search requires at most 22`)
})

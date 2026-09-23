import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyForecastMethod,
  checkSignDomain,
  forecastETS,
} from './forecast'

// A metric's sign domain: revenue cannot go negative, so a projection that
// crosses zero must carry an explicit caveat naming the model and why —
// never a silent clamp, and never presented as attainable revenue.

// Six months of revenue falling ~0.7M a month from ~4M: the classic ETS
// extrapolation drives through zero inside a 6-month horizon.
const DECLINING = [4_000_000, 3_300_000, 2_600_000, 1_900_000, 1_200_000, 500_000]

test('nonnegative domain breaches on the first negative value only', () => {
  assert.deepEqual(checkSignDomain([3, 2, 1], 'nonnegative'), { breached: false, firstIndex: -1 })
  assert.deepEqual(checkSignDomain([3, 0, 0.5], 'nonnegative'), { breached: false, firstIndex: -1 })
  assert.deepEqual(checkSignDomain([3, -0.5, -2], 'nonnegative'), { breached: true, firstIndex: 1 })
  assert.deepEqual(checkSignDomain([], 'nonnegative'), { breached: false, firstIndex: -1 })
})

test('unbounded metrics never breach, however negative', () => {
  assert.deepEqual(checkSignDomain([3, -50, -2000], 'any'), { breached: false, firstIndex: -1 })
})

test('a declining revenue series breaches inside the horizon', () => {
  const ets = applyForecastMethod(DECLINING, 'ets', 6, 'none', 90)
  const breach = checkSignDomain(ets.values, 'nonnegative')
  assert.equal(breach.breached, true, `ETS must cross zero, got ${ets.values}`)
  assert.ok(breach.firstIndex >= 0 && breach.firstIndex < 6)
  // The crossing is monotone in the breach index: everything from the first
  // negative month on is out of domain.
  assert.ok(ets.values.slice(breach.firstIndex).every((v) => v < 0))
})

test('phi = 1 reproduces the classic ETS exactly', () => {
  const classic = forecastETS(DECLINING, 6, 0)
  const explicit = forecastETS(DECLINING, 6, 0, 1.645, 1)
  assert.deepEqual(explicit.values, classic.values)
})

test('the damped variant levels a decline off instead of extending it', () => {
  const plain = applyForecastMethod(DECLINING, 'ets', 6, 'none', 90)
  const damped = applyForecastMethod(DECLINING, 'ets_damped', 6, 'none', 90)
  assert.notDeepEqual(damped.values, plain.values)
  // Damping raises every month of a declining projection (geometric trend
  // decay), so it breaches later — or never — and never earlier.
  for (let h = 0; h < 6; h++) {
    assert.ok(damped.values[h]! >= plain.values[h]!, `damped month ${h} must sit above plain ETS`)
  }
  const plainBreach = checkSignDomain(plain.values, 'nonnegative')
  const dampedBreach = checkSignDomain(damped.values, 'nonnegative')
  assert.ok(
    !dampedBreach.breached || dampedBreach.firstIndex >= plainBreach.firstIndex,
    'damping must not bring the zero crossing forward',
  )
})

test('a flat series is identical under both ETS variants', () => {
  const flat = [1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000]
  assert.deepEqual(
    applyForecastMethod(flat, 'ets_damped', 6, 'none', 90).values,
    applyForecastMethod(flat, 'ets', 6, 'none', 90).values,
  )
})

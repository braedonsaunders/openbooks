import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyForecastMethod,
  checkSignDomain,
  forecastETS,
  zScoreForConfidence,
  type ForecastModelParams,
} from './forecast'
import { ANALYTICS_CONFIG } from '../../../../lib/analytics/config-spec'

// A metric's sign domain: revenue cannot go negative, so a projection that
// crosses zero must carry an explicit caveat naming the model and why —
// never a silent clamp, and never presented as attainable revenue.

// The engine keeps no starting constants: every model value comes from the
// analytics threshold spec, the same source the dashboard loader reads, so
// a tuned policy is what the tests price too.
const SPEC = ANALYTICS_CONFIG.financialHealth.defaults
const MODEL: ForecastModelParams = {
  alpha: SPEC.forecastEtsAlpha as number,
  beta: SPEC.forecastEtsBeta as number,
  gamma: SPEC.forecastEtsGamma as number,
  dampedPhi: SPEC.forecastDampedPhi as number,
  ma1: SPEC.forecastMa1 as number,
  minCorrelation: SPEC.forecastSeasonalityMinCorr as number,
  minPeriods: SPEC.forecastSeasonalityMinPeriods as number,
}
const OPTS = { modelParams: MODEL, periodsPerYear: 12 }

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
  const ets = applyForecastMethod(DECLINING, 'ets', 6, 'none', 90, null, OPTS)
  const breach = checkSignDomain(ets.values, 'nonnegative')
  assert.equal(breach.breached, true, `ETS must cross zero, got ${ets.values}`)
  assert.ok(breach.firstIndex >= 0 && breach.firstIndex < 6)
  // The crossing is monotone in the breach index: everything from the first
  // negative month on is out of domain.
  assert.ok(ets.values.slice(breach.firstIndex).every((v) => v < 0))
})

test('phi = 1 reproduces the classic ETS exactly', () => {
  // The 'ets' method dispatches the undamped variant with the configured
  // model: the same series direct and through the dispatcher must agree.
  const direct = forecastETS(DECLINING, 6, 0, zScoreForConfidence(90), 1, MODEL)
  const viaMethod = applyForecastMethod(DECLINING, 'ets', 6, 'none', 90, null, OPTS)
  assert.deepEqual(viaMethod.values, direct.values)
})

test('the damped variant levels a decline off instead of extending it', () => {
  const plain = applyForecastMethod(DECLINING, 'ets', 6, 'none', 90, null, OPTS)
  const damped = applyForecastMethod(DECLINING, 'ets_damped', 6, 'none', 90, null, OPTS)
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

test('an unknown confidence level refuses instead of assuming 1.645', () => {
  assert.equal(zScoreForConfidence(90), 1.645)
  // 97 has no band multiplier: the engine throws a named refusal rather
  // than printing a 90% band under another name.
  assert.throws(() => applyForecastMethod(DECLINING, 'ets', 6, 'none', 97, null, OPTS), /unknown forecast confidence level 97/)
})

test('a flat series is identical under both ETS variants', () => {
  const flat = [1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000]
  assert.deepEqual(
    applyForecastMethod(flat, 'ets_damped', 6, 'none', 90, null, OPTS).values,
    applyForecastMethod(flat, 'ets', 6, 'none', 90, null, OPTS).values,
  )
})

test('a quarterly cycle on a quarterly calendar collapses to trend', () => {
  // Four periods a year cannot exhibit a quarterly cycle: "quarterly" must
  // price the linear trend, never invent a two-period season.
  const quarterlyOpts = { modelParams: MODEL, periodsPerYear: 4 }
  const seasonal = applyForecastMethod(DECLINING, 'seasonal', 6, 'quarterly', 90, null, quarterlyOpts)
  const linear = applyForecastMethod(DECLINING, 'linear', 6, 'quarterly', 90, null, quarterlyOpts)
  assert.deepEqual(seasonal.values, linear.values)
})

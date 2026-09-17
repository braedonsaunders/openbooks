import assert from 'node:assert/strict'
import test from 'node:test'
import { tickInterval } from './charts'

/**
 * F-t05-010 — the cash-trend x-axis must thin out deterministically (fewer
 * ticks) instead of letting ECharts' width-dependent auto stride swap which
 * labels render ("Aug 24" one width, "Aug 4" the next).
 */
test('short series show every tick', () => {
  assert.equal(tickInterval(1, 5), 0)
  assert.equal(tickInterval(5, 5), 0)
  assert.equal(tickInterval(6, 5), 1)
})

test('long series thin to at most maxTicks', () => {
  // 13 weekly points capped to 5 ticks → every 3rd label.
  assert.equal(tickInterval(13, 5), 2)
  // Shown ticks = ceil(count / (interval + 1)) <= maxTicks.
  for (const count of [7, 10, 13, 26, 52]) {
    const interval = tickInterval(count, 5)
    assert.ok(
      Math.ceil(count / (interval + 1)) <= 5,
      `${count} labels with interval ${interval} must fit 5 ticks`,
    )
  }
})

test('degenerate caps fall back to showing everything', () => {
  assert.equal(tickInterval(13, 0), 0)
  assert.equal(tickInterval(13, -2), 0)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { cashBridgeOption, tickInterval } from './charts'

/**
 * the cash-trend x-axis must thin out deterministically (fewer
 * ticks) instead of letting ECharts' width-dependent auto stride swap which
 * labels render ("Aug 24" one width, "Aug 4" the next).
 */
test('short series show every tick', () => {
  assert.equal(tickInterval(1, 5), 0)
  assert.equal(tickInterval(5, 5), 0)
  assert.equal(tickInterval(6, 5), 1)
})

test('long series thin to at most maxTicks', () => {
  assert.equal(tickInterval(13, 5), 2)
  for (const count of [7, 10, 13, 26, 52]) {
    const interval = tickInterval(count, 5)
    assert.ok(
      Math.ceil(count / (interval + 1)) <= 5,
      `${count} labels with interval ${interval} must fit 5 ticks`,
    )
  }
})

test('cash bridge computes its outflow geometry before numeric projection', () => {
  const option = cashBridgeOption('0.1', '0.2', '0.1', '0.2', (value) => String(value), {
    start: 'Start', inflows: 'In', outflows: 'Out', projectedEnd: 'End',
  }) as { series: { data: { value: number }[] }[] }
  assert.equal(option.series[2]?.data[2]?.value, 0.1)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { customerPulseTimelineParams } from './customer-pulse-timeline-params'
import { preparedListSource, preparedPageState } from './list/prepared-sources'

test('customer history owns its paging and search independently of the host list', () => {
  assert.deepEqual(customerPulseTimelineParams({ page: '8', q: 'host', perPage: '100', dir: 'asc' }),
    { page: 1, perPage: 25, q: '', dir: 'desc' })
  assert.deepEqual(customerPulseTimelineParams({ pulseHistoryPage: '3', pulseHistoryPerPage: '50', pulseHistoryQ: '  invoice  ', pulseHistoryDir: 'asc' }),
    { page: 3, perPage: 50, q: 'invoice', dir: 'asc' })
  assert.deepEqual(customerPulseTimelineParams({ pulseHistoryPage: '-9', pulseHistoryPerPage: '1000000' }),
    { page: 1, perPage: 100, q: '', dir: 'desc' })
})

test('customer history registers a server window, never a loaded array to re-page in the browser', () => {
  const source = preparedListSource('customer_pulse_history')
  assert.equal(source.mode, 'server')
  assert.equal(source.clientSearch, false)
  assert.equal(source.paging?.pageParamKey, 'pulseHistoryPage')
  assert.deepEqual(preparedPageState(source, { rows: [], total: 94, page: 4, perPage: 25 }), { total: 94, page: 4, perPage: 25 })
})

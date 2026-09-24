import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
registerHooks({resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  if (specifier === '../money-server') return { shortCircuit: true, url: 'data:text/javascript,export async function getMoneyFormatter(){return {money:String,moneyCompact:String}}' }
  return next(specifier, context)
}})
const { buildTimeline } = await import('../cash/cash-position')

test('cash forecast rolls fractional flows exactly above the safe integer range', () => {
  const firstWeek = '2026-09-07'
  const secondWeek = '2026-09-14'
  const arEntries = [
    {
      id: 'ar-1', entryId: 'ar-1', docKind: 'customer_invoice', docNumber: 'AR-1', docId: 'doc-1',
      partyId: 'customer-1', partyName: 'Northwind', amount: '0.1251', tranDate: firstWeek,
      dueDate: firstWeek, predictedDate: firstWeek, weekStart: firstWeek, daysOverdue: 0, method: 'terms',
    },
  ]
  const laterArEntries = [
    {
      id: 'ar-2', entryId: 'ar-2', docKind: 'customer_invoice', docNumber: 'AR-2', docId: 'doc-2',
      partyId: 'customer-1', partyName: 'Northwind', amount: '0.0001', tranDate: secondWeek,
      dueDate: secondWeek, predictedDate: secondWeek, weekStart: secondWeek, daysOverdue: 0, method: 'terms',
    },
  ]
  const categories = [{
    id: 'insurance', name: 'Insurance', direction: 'outflow' as const, method: 'fixed_weekly' as const,
    weekly: ['0.2500', '0.1250'], total: '0.3750', logic: 'Scheduled premium',
    meta: { method: 'Fixed weekly' }, breakdown: [],
  }]

  const timeline = buildTimeline({
    weekStarts: [firstWeek, secondWeek],
    startingCash: '9007199254740993.0000',
    arByWeek: new Map([[firstWeek, arEntries], [secondWeek, laterArEntries]]),
    apByWeek: new Map(),
    categories,
    apSettings: { weeklyCap: '0.0000', restrictToSafe: false },
  })

  assert.deepEqual(timeline.weeks.map((week) => [week.inflow, week.outflow, week.net, week.endingCash]), [
    ['0.1251', '0.2500', '-0.1249', '9007199254740992.8751'],
    ['0.0001', '0.1250', '-0.1249', '9007199254740992.7502'],
  ])
  assert.equal(timeline.totalInflows, '0.1252')
  assert.equal(timeline.totalOutflows, '0.3750')
})

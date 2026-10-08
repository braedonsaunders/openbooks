import assert from 'node:assert/strict'
import test from 'node:test'
import { boardLegend, filterBoardRows } from './legend'
import type { BoardWindow } from './model'

const window = {
  board: { showWeekends: false }, replaced: ['old'],
  days: [{ date: '2026-10-08', isWeekend: false }, { date: '2026-10-10', isWeekend: true }],
  rows: [{ subjectId: 'one', name: 'Alex', jobTitle: 'Service', tradeName: null },
    { subjectId: 'two', name: 'Blair', jobTitle: 'Shop', tradeName: null },
    { subjectId: 'three', name: 'Cleo', jobTitle: 'Shop', tradeName: null }],
  entries: [{ id: 'booking', subjectId: 'one', startsOn: '2026-10-08', target: { code: 'SHOP', label: 'Shop work', color: null } },
    { id: 'old', subjectId: 'three', startsOn: '2026-10-08', target: { code: 'SHOP', label: 'Shop work', color: null } }],
  sourceRecords: [{ workerPartyId: 'two', onDate: '2026-10-08', label: 'SHOP', result: 'Literal instruction', color: '#38bdf8' },
    { workerPartyId: 'two', onDate: '2026-10-08', label: 'SHOP', result: 'Second source row', color: '#38bdf8' },
    { workerPartyId: 'three', onDate: '2026-10-10', label: 'SHOP', result: null, color: null }],
} as unknown as BoardWindow

test('a value pill filters to matching booking and literal-history people without counting duplicates or hidden days', () => {
  const legend = boardLegend(window)
  assert.equal(legend.length, 1)
  assert.equal(legend[0]!.people.size, 2)
  assert.deepEqual(filterBoardRows(window, '', 'label:SHOP').map(row => row.subjectId), ['one', 'two'])
  assert.deepEqual(filterBoardRows(window, 'Blair', 'label:SHOP').map(row => row.subjectId), ['two'])
  assert.deepEqual(filterBoardRows(window, 'Literal instruction', 'label:SHOP').map(row => row.subjectId), ['two'])
  assert.deepEqual(filterBoardRows(window, '', null).map(row => row.subjectId), ['one', 'two', 'three'])
  assert.deepEqual(filterBoardRows(window, '', 'label:missing'), [])
})

import assert from 'node:assert/strict'
import test from 'node:test'
import type { CapTableView } from '@openbooks/engine/equity'
import { capTableExportData, capTableExportHref, type CapTableExportLabels } from './equity-cap-table-export'

const labels: CapTableExportLabels = {
  title: 'Main Co — cap table', dateRange: 'As of 2026-07-31', class: 'Class', kind: (kind) => kind, holder: 'Holder',
  column: (key) => `[${key}]`, total: 'Total',
}

const view = {
  entity: { id: 'sub', name: 'Main Co', currency: 'CAD' },
  hasAccountPolicy: true,
  parties: { founder: 'Founder One' },
  table: {
    asOf: '2026-07-31',
    classes: [{
      shareClassId: 'cs', code: 'CS', name: 'Common', kind: 'common', seniority: 0, authorized: '10000000', outstanding: '9007199254740993',
      asConvertedOutstanding: '9007199254740993', awardsOutstanding: '0', poolAvailable: '0', fullyDiluted: '9007199254740993', conversionRatio: '1.0000000000',
      parValue: '0.0001000000', originalIssuePrice: null, conversionPrice: null, outstandingPercent: '100.0000', fullyDilutedPercent: '100.0000',
    }],
    holders: [{
      holderPartyId: 'founder', sharesByClass: { cs: '9007199254740993' }, asConvertedOutstanding: '9007199254740993', options: '0', rsus: '0', warrants: '0',
      vestedAwards: '0', fullyDiluted: '9007199254740993', outstandingPercent: '100.0000', fullyDilutedPercent: '100.0000',
    }],
    plans: [], holdings: [], convertibles: [],
    totals: { outstanding: '9007199254740993', asConvertedOutstanding: '9007199254740993', awardsOutstanding: '0', poolAvailable: '0', fullyDiluted: '9007199254740993' },
  },
} as CapTableView

const all = (dimension: 'class' | 'holder') => ({ dimension, instrument: 'all' as const, query: '' })

test('the cap table exports by class and by holder with share counts kept as exact text', () => {
  const byClass = capTableExportData(view, all('class'), labels)
  assert.equal(byClass.groups[0]!.rows[0]![2], '9007199254740993', 'a count above 2^53 is never coerced through a float')
  assert.equal(byClass.groups[0]!.columns.length, byClass.groups[0]!.rows[0]!.length)
  const byHolder = capTableExportData(view, all('holder'), labels)
  assert.deepEqual(byHolder.groups[0]!.columns.slice(0, 2), ['Holder', 'CS'])
  assert.equal(byHolder.groups[0]!.rows[0]![0], 'Founder One')
  assert.deepEqual(byHolder.groups[0]!.rows.at(-1)!.slice(0, 2), ['Total', '9007199254740993'], 'the totals row the page shows closes the export')
})

test('the export link carries the legal entity, date and every filter the page applies', () => {
  assert.equal(capTableExportHref('sub', '2026-07-31', all('holder')), '/api/equity/cap-table/export?subsidiaryId=sub&asOf=2026-07-31&by=holder')
  assert.equal(
    capTableExportHref('sub', '2026-07-31', { dimension: 'class', instrument: 'option', query: 'Series A' }),
    '/api/equity/cap-table/export?subsidiaryId=sub&asOf=2026-07-31&by=class&instrument=option&q=Series+A',
  )
})

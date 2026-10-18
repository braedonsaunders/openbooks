import assert from 'node:assert/strict'
import test from 'node:test'
import type { CapTableView } from '@openbooks/engine/equity'
import { capTableExportData, capTableExportHref, type CapTableExportLabels } from './equity-cap-table-export'

const labels: CapTableExportLabels = {
  title: 'Main Co — cap table', dateRange: 'As of 2026-07-31', class: 'Class', kind: (kind) => kind, holder: 'Holder', authorized: 'Authorized',
  outstanding: 'Outstanding', asConverted: 'As converted', awards: 'Awards', pool: 'Pool', fullyDiluted: 'Fully diluted',
  outstandingPercent: 'Outstanding %', fullyDilutedPercent: 'Fully diluted %', options: 'Options', rsus: 'RSUs', warrants: 'Warrants',
  totalOutstanding: 'Total outstanding', totalFullyDiluted: 'Total fully diluted', poolUnallocated: 'Unallocated pool',
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

test('the cap table exports by class and by holder with share counts kept as exact text', () => {
  const byClass = capTableExportData(view, 'class', labels)
  assert.equal(byClass.groups[0]!.rows[0]![2], '9007199254740993', 'a count above 2^53 is never coerced through a float')
  assert.equal(byClass.groups[0]!.columns.length, byClass.groups[0]!.rows[0]!.length)
  const byHolder = capTableExportData(view, 'holder', labels)
  assert.deepEqual(byHolder.groups[0]!.columns.slice(0, 2), ['Holder', 'CS'])
  assert.equal(byHolder.groups[0]!.rows[0]![0], 'Founder One')
  assert.deepEqual(byHolder.summary.map((item) => item.value), ['9007199254740993', '9007199254740993', '0'])
})

test('the export link names the legal entity, date and basis', () => {
  assert.equal(capTableExportHref('sub', '2026-07-31', 'holder'), '/api/equity/cap-table/export?subsidiaryId=sub&asOf=2026-07-31&by=holder')
})

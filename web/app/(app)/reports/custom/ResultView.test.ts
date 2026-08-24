import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import type { ReportCellLink, ReportRunResult } from '@openbooks/reports'
import type { ReportDrillTarget } from '../../../../lib/report-drill'
import { resultGroupsForPaper } from './paper-groups'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

const customTarget: ReportDrillTarget = {
  kind: 'custom',
  label: 'Lot recall',
  source: 'definition',
  id: '018f75ee-9888-7000-8000-000000000003',
}

test('detail-cell transaction metadata reaches the shared paper unchanged', () => {
  const target: ReportCellLink = {
    kind: 'transaction',
    entryId: '018f75ee-9888-7000-8000-000000000001',
    docId: '018f75ee-9888-7000-8000-000000000002',
    docKind: 'inventory_adjustment',
  }
  const result: ReportRunResult = {
    groups: [{
      kind: 'results',
      title: 'Results',
      columns: ['Document #', 'Lot'],
      rows: [['IA-1042', 'LOT-7']],
      cellLinks: [[target, null]],
    }],
    summary: [],
    rowCount: 1,
  }

  const groups = resultGroupsForPaper(result, customTarget)

  assert.strictEqual(groups[0]?.cellLinks?.[0]?.[0], target)
  assert.equal(groups[0]?.cellLinks?.[0]?.[1], null)
  // Rows-mode cells ARE the record — the viewer must not fabricate drills
  // behind them and thereby shadow the native transaction links.
  assert.equal(groups[0]?.drills, undefined)
})

test('summary aggregates gain bucket-scoped drills only on numeric cells', () => {
  const result: ReportRunResult = {
    groups: [{
      kind: 'summary',
      title: 'By lot',
      columns: ['Lot', 'Quantity'],
      rows: [['LOT-7', '1,204.5'], ['LOT-9', 'n/a'], [undefined as unknown as string, 12]],
      rowKeys: [
        [{ field: 'lot_number', value: 'LOT-7' }],
        null,
        [{ field: 'lot_number', empty: true }],
      ],
    }],
    summary: [],
    rowCount: 3,
  }

  const groups = resultGroupsForPaper(result, customTarget)
  const drills = groups[0]?.drills

  assert.ok(drills)
  assert.equal(drills[0]?.[0], undefined, 'non-numeric text cells stay undrillable')
  assert.deepEqual(drills[0]?.[1], { ...customTarget, filter: [{ field: 'lot_number', value: 'LOT-7' }] })
  assert.deepEqual(drills[1], [undefined, undefined], 'a row without scope rules gets no drill')
  assert.equal(drills[2]?.[0], undefined)
  assert.deepEqual(drills[2]?.[1], { ...customTarget, filter: [{ field: 'lot_number', empty: true }] })
})

test('non-custom drill targets leave summary groups untouched', () => {
  const ledgerTarget: ReportDrillTarget = {
    kind: 'ledger',
    label: 'General ledger',
    to: '2026-12-31',
    mode: 'balance',
  }
  const result: ReportRunResult = {
    groups: [{
      kind: 'summary',
      title: 'Totals',
      columns: ['Amount'],
      rows: [[42]],
      rowKeys: [[{ field: 'account_id', value: 'a' }]],
    }],
    summary: [],
    rowCount: 1,
  }

  const groups = resultGroupsForPaper(result, ledgerTarget)
  assert.equal(groups[0]?.drills, undefined)
  assert.equal(groups[0]?.rows[0]?.[0], 42)
})

test('PaperView delegates transaction cells to the native TxnLink flow', () => {
  const source = read('../PaperView.tsx')
  const view = read('./ResultView.tsx')
  const helper = read('./paper-groups.ts')
  assert.match(source, /cellLink\?\.kind === 'transaction'/)
  assert.match(source, /<TxnLink target=\{cellLink\}/)
  assert.match(view, /resultGroupsForPaper\(result, drillTarget\)/)
  assert.match(helper, /cellLinks: group\.cellLinks/)
})

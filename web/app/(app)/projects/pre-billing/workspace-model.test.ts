import assert from 'node:assert/strict'
import test from 'node:test'
import { PREBILL_STAGES } from '../../../../lib/pre-billing-stages'
import { decimalSum } from '../../../../lib/statement-format'
import { projectWorkspace, parseWorkspaceStage, CLOSED_CARD_LIMIT } from './workspace-model'
import { worksheet, unbilledProject } from './workspace-fixtures'

const defaults = { query: '', stage: null, approvalFlowsConfigured: true, customerPortalEnabled: true }

test('board and table project the same open work, including unbilled projects without worksheet identities', () => {
  const work = unbilledProject({ projectId: 'same-id' })
  const prebills = PREBILL_STAGES.map((stage) => worksheet(stage, { id: stage === 'draft' ? 'same-id' : stage }))
  const result = projectWorkspace({ ...defaults, unbilled: [work], prebills })
  assert.equal(result.openCount, 7)
  assert.equal(result.stages.find((stage) => stage.key === 'unbilled')!.count, 1, 'count projects, not their seven sources')
  assert.deepEqual(result.rows, result.lanes.flatMap((lane) => lane.rows))
  assert.equal(new Set(result.rows.map((entry) => entry.key)).size, result.rows.length)
  const entry = result.rows[0]!
  assert.equal(entry.kind, 'unbilled')
  assert.equal(entry.source, work)
  assert.ok(!('worksheetNumber' in entry.source))
  assert.equal(result.total, '625.0000')
  assert.ok(!result.rows.some((entry) => entry.stage === 'paid' || entry.stage === 'void'))
})

test('paid and void filters expose complete rows and exact totals independently of the closed board cap', () => {
  for (const stage of ['paid', 'void'] as const) {
    const prebills = Array.from({ length: CLOSED_CARD_LIMIT + 3 }, (_, index) => worksheet(stage, {
      id: String(index), invoiceTotal: index === 0 ? '900719925474099.1234' : '0.0001', proposedBillAmount: '999.0000',
    }))
    const result = projectWorkspace({ ...defaults, stage, unbilled: [], prebills })
    assert.equal(result.rows.length, 15)
    assert.equal(result.stages.find((value) => value.key === stage)!.count, 15)
    assert.deepEqual(result.rows, result.lanes[0]!.rows)
    assert.equal(result.total, '900719925474099.1248')
    assert.equal(result.lanes[0]!.total, result.total)
    assert.equal(result.openCount, 0)
  }
})

test('search narrows both views and all counts before stage selection without hiding applicable zero-count stages', () => {
  const prebills = [worksheet('review', { invoiceNumber: 'INV-007' }), worksheet('customer')]
  const result = projectWorkspace({ ...defaults, approvalFlowsConfigured: false, customerPortalEnabled: false,
    query: ' inv-007 ', stage: 'review', prebills, unbilled: [unbilledProject()] })
  assert.equal(result.rows.length, 1)
  assert.equal(result.openCount, 1)
  assert.equal(result.stages.find((stage) => stage.key === 'customer')!.count, 0)
  assert.deepEqual(result.rows, result.lanes[0]!.rows)
  const empty = projectWorkspace({ ...defaults, query: 'missing', prebills, unbilled: [] })
  assert.ok(empty.stages.every((stage) => stage.count === 0 && stage.total === '0.0000'))
  assert.equal(empty.nothingYet, false, 'search empty is distinct from an organization with no work')
})

test('configured stages remain available when empty and optional deep links resolve even without configuration', () => {
  const empty = projectWorkspace({ ...defaults, unbilled: [], prebills: [] })
  assert.equal(empty.stages.length, 9)
  assert.ok(empty.stages.every((stage) => stage.count === 0))
  assert.equal(empty.nothingYet, true)
  const optional = projectWorkspace({ ...defaults, stage: 'review', approvalFlowsConfigured: false,
    customerPortalEnabled: false, unbilled: [], prebills: [] })
  assert.deepEqual(optional.lanes.map((stage) => stage.key), ['review'])
  assert.equal(parseWorkspaceStage('unbilled'), 'unbilled')
  assert.equal(parseWorkspaceStage('paid'), 'paid')
  assert.equal(parseWorkspaceStage('void'), 'void')
  assert.equal(parseWorkspaceStage('unknown'), null)
})

test('invoice amounts including zero override proposals consistently; unbilled selection retains project command data', () => {
  const work = unbilledProject({ unbilledAmount: '0.0001' })
  const prebills = [worksheet('invoiced', { invoiceTotal: '0.0000' }), worksheet('sent', { invoiceTotal: '0.1001' })]
  const result = projectWorkspace({ ...defaults, prebills, unbilled: [work] })
  assert.equal(result.total, '0.1002')
  assert.equal(result.total, decimalSum(result.lanes.map((lane) => lane.total)))
  const unbilled = projectWorkspace({ ...defaults, stage: 'unbilled', prebills, unbilled: [work] })
  assert.equal(unbilled.rows.length, 1)
  assert.equal(unbilled.rows[0]!.source, work)
  assert.equal(unbilled.total, '0.0001')
})

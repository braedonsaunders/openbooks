import assert from 'node:assert/strict'
import test from 'node:test'
import { PREBILL_STAGES } from '../../../../lib/pre-billing-stages'
import { decimalSum } from '../../../../lib/statement-format'
import { projectWorkspace, parseWorkspaceStage, WORKSPACE_STAGES } from './workspace-model'
import { worksheet, unbilledProject } from './workspace-fixtures'

const defaults = { query: '', stage: null, approvalFlowsConfigured: true, customerPortalEnabled: true }
const baseStages = ['unbilled', 'draft', 'ready', 'invoiced', 'sent']
const allActiveStages = ['unbilled', 'draft', 'review', 'ready', 'customer', 'invoiced', 'sent']

test('one ordered operational contract defaults to To pre-bill and excludes aggregate and closed stages', () => {
  assert.deepEqual(WORKSPACE_STAGES, allActiveStages)
  const result = projectWorkspace({ ...defaults, approvalFlowsConfigured: false, customerPortalEnabled: false, unbilled: [], prebills: [] })
  assert.deepEqual(result.stages.map((stage) => stage.key), baseStages)
  assert.equal(result.activeStage, 'unbilled')
  assert.equal(result.lanes, result.stages)
  for (const value of [null, '', 'all', 'all-open', 'all_open', 'paid', 'void', 'unknown']) {
    assert.equal(parseWorkspaceStage(value), 'unbilled')
  }
  for (const stage of WORKSPACE_STAGES) assert.equal(parseWorkspaceStage(stage), stage)
})

test('every selection retains all Kanban columns while the table uses that exact stage data and total', () => {
  const work = unbilledProject({ projectId: 'same-id' })
  const prebills = PREBILL_STAGES.map((stage) => worksheet(stage, { id: stage === 'draft' ? 'same-id' : stage }))
  for (const stage of WORKSPACE_STAGES) {
    const result = projectWorkspace({ ...defaults, stage, unbilled: [work], prebills })
    assert.deepEqual(result.lanes.map((lane) => lane.key), allActiveStages)
    assert.equal(result.activeStage, stage)
    const lane = result.lanes.find((lane) => lane.key === stage)!
    assert.equal(result.rows, lane.rows)
    assert.equal(result.total, lane.total)
    assert.equal(result.rows.length, 1)
    assert.equal(result.stages.find((lane) => lane.key === 'unbilled')!.count, 1, 'count projects, not their seven work sources')
    const cards = result.lanes.flatMap((lane) => lane.rows)
    assert.equal(cards.length, 7)
    assert.equal(new Set(cards.map((card) => card.key)).size, 7, 'projects and worksheets retain distinct command identities')
    assert.equal(decimalSum(result.lanes.map((lane) => lane.total)), '625.0000')
  }
  const result = projectWorkspace({ ...defaults, unbilled: [work], prebills })
  assert.equal(result.rows[0]!.kind, 'unbilled')
  assert.equal(result.rows[0]!.source, work)
  assert.ok(!('worksheetNumber' in result.rows[0]!.source))
})

test('closed records remain unchanged but never enter operational cards, rows, counts or totals', () => {
  const prebills = [...Array.from({ length: 15 }, (_, index) => worksheet('paid', { id: `paid-${index}`, invoiceTotal: '900719925474099.1234' })), worksheet('void', { customerReviewRequired: true })]
  const before = JSON.stringify(prebills)
  for (const stage of ['all', 'paid', 'void']) {
    const result = projectWorkspace({ ...defaults, approvalFlowsConfigured: false, customerPortalEnabled: false, stage, unbilled: [unbilledProject()], prebills })
    assert.equal(result.activeStage, 'unbilled')
    assert.deepEqual(result.stages.map((lane) => lane.key), baseStages)
    assert.equal(result.rows.length, 1)
    assert.equal(result.total, '25.0000')
    assert.equal(result.lanes.flatMap((lane) => lane.rows).length, 1)
  }
  const closedOnly = projectWorkspace({ ...defaults, unbilled: [], prebills })
  assert.equal(closedOnly.nothingYet, true)
  assert.ok(closedOnly.stages.every((lane) => lane.count === 0 && lane.total === '0.0000'))
  assert.equal(JSON.stringify(prebills), before)
  assert.ok(PREBILL_STAGES.includes('paid') && PREBILL_STAGES.includes('void'), 'native lifecycle stages remain supported')
})

test('optional stages follow genuine configuration and active workflow needs, independent of search or unsupported deep links', () => {
  const off = { ...defaults, approvalFlowsConfigured: false, customerPortalEnabled: false, unbilled: [], prebills: [] }
  for (const stage of ['review', 'customer']) {
    const result = projectWorkspace({ ...off, stage })
    assert.deepEqual(result.stages.map((lane) => lane.key), baseStages)
    assert.equal(result.activeStage, 'unbilled')
  }
  const review = projectWorkspace({ ...off, prebills: [worksheet('review')] })
  assert.deepEqual(review.stages.map((lane) => lane.key), ['unbilled', 'draft', 'review', 'ready', 'invoiced', 'sent'])
  const required = projectWorkspace({ ...off, prebills: [worksheet('ready', { customerReviewRequired: true })], query: 'no match' })
  assert.deepEqual(required.stages.map((lane) => lane.key), ['unbilled', 'draft', 'ready', 'customer', 'invoiced', 'sent'])
  assert.ok(required.stages.every((lane) => lane.count === 0))
  assert.deepEqual(projectWorkspace({ ...defaults, unbilled: [], prebills: [] }).stages.map((lane) => lane.key), allActiveStages)
})

test('search counts and exact stage totals agree before selection, including meaningful filtered-empty stages', () => {
  const prebills = [worksheet('review', { invoiceNumber: 'INV-007' }), worksheet('customer')]
  for (const stage of WORKSPACE_STAGES) {
    const result = projectWorkspace({ ...defaults, query: ' inv-007 ', stage, prebills, unbilled: [unbilledProject()] })
    assert.equal(result.stages.find((lane) => lane.key === 'review')!.count, 1)
    assert.ok(result.stages.filter((lane) => lane.key !== 'review').every((lane) => lane.count === 0))
    assert.equal(result.rows.length, stage === 'review' ? 1 : 0)
    assert.equal(result.total, stage === 'review' ? '100.0000' : '0.0000')
    assert.equal(result.nothingYet, false)
  }
  const empty = projectWorkspace({ ...defaults, query: 'missing', prebills, unbilled: [] })
  assert.equal(empty.lanes.length, 7)
  assert.ok(empty.stages.every((lane) => lane.count === 0 && lane.total === '0.0000'))
  assert.equal(empty.nothingYet, false, 'filtered empty is distinct from no active work')
})

test('empty Kanban and zero stage data preserve the ordered applicable workflow for every selection', () => {
  for (const stage of WORKSPACE_STAGES) {
    const result = projectWorkspace({ ...defaults, stage, unbilled: [], prebills: [] })
    assert.equal(result.activeStage, stage)
    assert.deepEqual(result.lanes.map((lane) => lane.key), allActiveStages)
    assert.ok(result.lanes.every((lane) => lane.count === 0 && lane.rows.length === 0))
    assert.equal(result.rows.length, 0)
    assert.equal(result.total, '0.0000')
    assert.equal(result.nothingYet, true)
  }
})

test('issued invoice amounts including zero override proposals, with complete exact totals independent of pagination', () => {
  const work = unbilledProject({ unbilledAmount: '0.0001' })
  const prebills = [worksheet('invoiced', { invoiceTotal: '900719925474099.1234' }), worksheet('invoiced', { id: 'second-invoice', invoiceTotal: '0.0001' }), worksheet('sent', { invoiceTotal: '0.0000' })]
  const result = projectWorkspace({ ...defaults, stage: 'invoiced', prebills, unbilled: [work] })
  assert.equal(result.total, '900719925474099.1235')
  assert.equal(result.rows.length, 2)
  assert.equal(result.lanes.find((lane) => lane.key === 'invoiced')!.total, result.total)
  assert.equal(result.lanes.find((lane) => lane.key === 'sent')!.total, '0.0000')
  const unbilled = projectWorkspace({ ...defaults, prebills, unbilled: [work] })
  assert.equal(unbilled.rows[0]!.source, work)
  assert.equal(unbilled.total, '0.0001')
})

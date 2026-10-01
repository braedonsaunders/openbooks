import assert from 'node:assert/strict'
import test from 'node:test'
import { stubModules } from '../../../../testing/stub-modules'

// Replace service reads, never validation or navigation composition.
stubModules({ intl: true, extra: {
  '@openbooks/engine/src/hrm/performance/performance-read.ts': `export async function listCycleProgress() { return [] }`,
  '@openbooks/engine/src/hrm/performance/talent.ts': `
    export async function listTalentDirectory() { return { employments: [], positions: [] } }
    export async function listTalentReviews() { throw new Error('No cycle must not query assessments') }
    export async function nineBoxForCycle() { throw new Error('No cycle must not query a matrix') }
    export async function listSuccessionPlans() { return [{ id: 'plan', positionCode: 'CEO', positionTitle: 'Chief executive', incumbentName: null, candidates: [], status: 'draft' }] }
  `,
  '@openbooks/engine/src/hrm/performance/calibration.ts': `
    export async function listCalibrationSessions() { return [{ id: 'session', name: 'Annual calibration', status: 'draft' }] }
    export async function getCalibrationSession() { throw new Error('A list must not implicitly open a session') }
    export async function calibrationDistribution() { throw new Error('A list must not query distributions') }
    export async function calibrationPotentialOptions() { throw new Error('A list must not query scales') }
  `,
} })
const { loadContinuousTab, continuousBlocks } = await import('./continuous-view')
const authz = { user: { orgId: 'org', id: 'actor' } } as Parameters<typeof loadContinuousTab>[0]

test('Talent names the missing cycle and offers a real create action', async () => {
  const data = await loadContinuousTab(authz, { tab: 'talent' }, true, true)
  assert.ok(data.talent, 'the workspace exists without cycles')
  assert.equal(data.talent.cycleId, '')
  const body = continuousBlocks(data)
  const empty = body.find((block) => block.kind === 'widget' && block.widget === 'empty-state')
  assert.ok(empty)
  assert.equal(empty.kind === 'widget' && empty.props?.action, 'plain-link-button', 'the shared empty-state receives its actual action prop')
  assert.equal(data.talent.cycleActionHref, '/hrm/performance?cycle=new')
})

test('Succession plans remain accessible without an assessment cycle', async () => {
  const data = await loadContinuousTab(authz, { tab: 'talent', talentView: 'succession' }, true, true)
  assert.equal(data.talent?.plans[0]?.position, 'CEO · Chief executive')
  const lists = continuousBlocks(data).filter((block) => block.kind === 'widget' && block.widget === 'registered-record-list')
  assert.equal(lists.length, 1)
  assert.equal(lists[0]?.kind === 'widget' && lists[0].props?.source, 'hrm_succession_plans')
  assert.equal(data.talent?.dialog.initialMode, 'succession')
})

test('Calibration opens a single working list without auto-selecting session details', async () => {
  const data = await loadContinuousTab(authz, { tab: 'calibration' }, true, true)
  assert.equal(data.calibration?.detail, null)
  const blocks = continuousBlocks(data)
  assert.equal(blocks.length, 1, 'New session belongs in the header')
  assert.equal(blocks[0]?.kind === 'widget' && blocks[0].props?.source, 'hrm_calibration_sessions')
})

test('an explicit succession plan opens its maintenance drawer, not a second page list', async () => {
  const data = await loadContinuousTab(authz, { tab: 'talent', talentView: 'succession', plan: 'plan' }, true, true)
  assert.equal(data.talent?.planDetail?.id, 'plan')
  assert.equal(data.talent?.planDetail?.closeHref, '/hrm/performance?tab=talent&talentView=succession')
  assert.deepEqual(data.talent?.planDetail?.readinessOptions.map((option) => option.value), ['ready_now', 'one_to_two_years', 'three_plus'])
  assert.ok(continuousBlocks(data).some((block) => block.kind === 'widget' && block.widget === 'hrm-succession-plan'))
})

test('a missing or inaccessible plan names the remedy without exposing another plan', async () => {
  const data = await loadContinuousTab(authz, { tab: 'talent', talentView: 'succession', plan: 'outside-scope' }, true, true)
  assert.equal(data.talent?.planDetail, null)
  assert.ok(data.talent?.planMissing)
})

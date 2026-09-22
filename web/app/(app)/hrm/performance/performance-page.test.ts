import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * Performance page text contract: the tab composes the shared `table`
 * block (variant 'app') over loader-resolved rows with the shared
 * the shared `list-toolbar` for status segments, the primary action is the shared
 * 'link-button' FIRST in the page header followed by 'module-home-tabs',
 * and no hand-rolled <table> remains in the surface. Drawers open from URL
 * search params through small client islands with the house form
 * primitives. Source-contract test: pins widget names and file shapes.
 */

const view = readFileSync(new URL('./view.ts', import.meta.url), 'utf8')
const sections = readFileSync(new URL('./sections.tsx', import.meta.url), 'utf8')
const continuousView = readFileSync(new URL('./continuous-view.ts', import.meta.url), 'utf8')
const answerForm = readFileSync(new URL('./ReviewAnswerForm.tsx', import.meta.url), 'utf8')
const actions = readFileSync(new URL('./ReviewActions.tsx', import.meta.url), 'utf8')
const cycleActions = readFileSync(new URL('./CycleActions.tsx', import.meta.url), 'utf8')
const createForm = readFileSync(new URL('./CycleCreateForm.tsx', import.meta.url), 'utf8')
const goalForm = readFileSync(new URL('./GoalForm.tsx', import.meta.url), 'utf8')
const exitForm = readFileSync(new URL('./ExitRecordForm.tsx', import.meta.url), 'utf8')

test('the performance list composes the shared table block with the shared toolbar', () => {
  assert.match(view, /table\(\{\s*variant: 'app'/, 'cycles render through the shared table block')
  assert.match(view, /widgetBlock\('list-toolbar'/, 'status segments use the shared list toolbar')
  assert.doesNotMatch(view, /widgetBlock\('filter-chips'/, 'no second filter treatment beside the toolbar')
  assert.match(view, /widget\('link-button', \{ href: f\('addHref'\), label: f\('addLabel'\), iconKey: 'plus' \}, f\('canManage'\)\)/,
    "the header's primary action is the shared link-button")
  assert.match(view, /widget\('module-home-tabs', \{ tabs: data\.tabs \}\)/, 'header carries the route-tab strip')
  assert.match(view, /badge\(item\('statusLabel'\), \{ variant: item\('statusVariant'\) \}\)/,
    'cycle status renders as a shared badge')
  assert.doesNotMatch(view, /<table/, 'no hand-rolled table in the spec')
  assert.doesNotMatch(sections, /<table/, 'no hand-rolled table in the drawers')
})

test('drawers open from URL search params through client islands', () => {
  assert.match(view, /sp\.cycle === 'new'/, 'the create dialog opens from ?cycle=new')
  assert.match(view, /typeof sp\.review === 'string'/, 'the review drawer opens from ?review=<id>')
  assert.match(sections, /hrm-cycle-drawer|CycleDrawer/, 'cycle drawer shell exists')
  assert.match(sections, /hrm-review-drawer|ReviewDrawer/, 'review drawer shell exists')
  // Retention is a TAB now, rendered through the house blocks. It used to be
  // a bespoke section stacked under the cycles table, beside an equally bare
  // feedback-settings form — three unrelated things down one page.
  assert.doesNotMatch(sections, /export function Retention/, 'no bespoke retention section remains')
  assert.match(view, /statTile\(\{/, 'retention renders through the house stat tiles')
  assert.match(continuousView, /'retention'/, 'retention is one of the view tabs')
  assert.match(continuousView, /'settings'/, 'feedback settings is one of the view tabs')
  assert.match(continuousView, /widgetBlock\('module-home-tabs', \{ tabs: data\.viewTabs \}\)/,
    'the view switch is the shared subtab strip, never an unlabelled dropdown')
})

test('islands use the house form primitives and surface API refusals', () => {
  for (const [name, source] of [
    ['ReviewAnswerForm', answerForm],
    ['ReviewActions', actions],
    ['CycleActions', cycleActions],
    ['CycleCreateForm', createForm],
    ['GoalForm', goalForm],
    ['ExitRecordForm', exitForm],
  ] as const) {
    assert.match(source, /from '@openbooks\/ui'/, `${name} uses the house primitives`)
    assert.match(source, /if\s*\(!res\.ok\)/, `${name} checks the error body before parsing it`)
  }
  assert.match(view, /listCycleProgress\(/, 'rows stay loader-resolved through the read service')
  assert.match(view, /getCycleDetail\(/, 'the cycle drawer resolves through the read service')
  assert.match(view, /getReviewDetail\(/, 'the review drawer resolves through the read service')
  assert.match(view, /getRetentionOverview\(/, 'the retention panel resolves through the read service')
  assert.ok(!/from ['"]@openbooks\/engine\/src\/platform\/db/.test(view), 'the loader issues no direct table reads')
})

test('the performance tab joins the HRM strip behind the feature switch', async () => {
  const groupTabs = readFileSync(
    new URL('../../../../components/module-home/group-tabs.ts', import.meta.url),
    'utf8',
  )
  assert.match(groupTabs, /href: '\/hrm\/performance'/, 'strip lands on the performance tab')
  assert.match(groupTabs, /'\/hrm\/performance': 'hrm'/, 'performance tab hides while the feature switch is off')
})

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * Canonical unsaved create contract across the low-risk configuration
 * surfaces (record types, insight cards/dashboards, knowledge views, reports).
 *
 * New opens URL/local unsaved form state, Cancel/close writes nothing, and
 * exactly one idempotent POST runs on explicit Save. These static pins guard
 * the shape; the route boundary suites prove the runtime behavior
 * (replay/conflict/audit/tenant isolation).
 */
const read = (path: string): string =>
  readFileSync(new URL(path, import.meta.url), 'utf8')

const newTypeButton = read('./records/types/NewTypeButton.tsx')
const newCardButton = read('./insights/NewCardButton.tsx')
const newDashboardButton = read('./insights/dashboards/NewDashboardButton.tsx')
const newViewButton = read('./knowledge/views/NewViewButton.tsx')
const newReportButton = read('./reports/custom/NewReportButton.tsx')

const typesView = read('./records/types/view.ts')
const insightsView = read('./insights/view.ts')
const viewsView = read('./knowledge/views/view.ts')
const reportBuilderView = read('./reports/custom/builder/[id]/view.ts')

const typeDrawer = read('./records/types/TypeBuilderDrawer.tsx')
const cardStudio = read('./insights/CardStudio.tsx')
const viewStudio = read('./knowledge/views/ViewStudio.tsx')
const reportBuilder = read('./reports/custom/builder/[id]/ReportBuilder.tsx')
const reportingWidgets = read('../../components/viewspec/widgets-reporting.tsx')

const typesRoute = read('../api/records/types/route.ts')
const cardsRoute = read('../api/insights/cards/route.ts')
const dashboardsRoute = read('../api/insights/dashboards/route.ts')
const viewsRoute = read('../api/views/route.ts')
const reportsRoute = read('../api/reports/definitions/route.ts')

test('New buttons navigate to unsaved state and never fetch on open', () => {
  for (const [name, source] of [
    ['NewTypeButton', newTypeButton],
    ['NewCardButton', newCardButton],
    ['NewViewButton', newViewButton],
    ['NewReportButton', newReportButton],
  ] as const) {
    assert.doesNotMatch(source, /fetch\(/, `${name} must perform zero writes on open`)
  }
  assert.match(newTypeButton, /\/records\/types\?type=new/)
  assert.match(newCardButton, /\/insights\?card=new/)
  assert.match(newViewButton, /\/knowledge\/views\?view=new/)
  assert.match(newReportButton, /\/reports\/custom\/builder\/new/)
})

test('New dashboard dialog holds local state and POSTs only on Save', () => {
  // The board builder is a detail page (no drawer), so create is a local
  // dialog like the house InviteDialog: zero writes until Save is explicit.
  assert.match(newDashboardButton, /const \[open, setOpen\]/)
  assert.doesNotMatch(newDashboardButton, /\/api\/insights\/dashboards\/draft/)
  assert.match(newDashboardButton, /Idempotency-Key/)
  assert.match(newDashboardButton, /if \(!res\.ok\)/)
})

test('list loaders open an unsaved drawer/studio for the new sentinel', () => {
  assert.match(typesView, /=== 'new'/)
  assert.match(insightsView, /=== 'new'/)
  assert.match(viewsView, /=== 'new'/)
  assert.match(reportBuilderView, /=== 'new'/)
  // The sentinel never reaches the row loaders as an id.
  assert.match(typesView, /!isCreate/)
  assert.match(insightsView, /!isCreate/)
  assert.match(viewsView, /!isCreate/)
  assert.match(reportBuilderView, /!createMode/)
})

test('drawers and studios gate autosave off in create mode', () => {
  for (const [name, source] of [
    ['TypeBuilderDrawer', typeDrawer],
    ['CardStudio', cardStudio],
    ['ViewStudio', viewStudio],
    ['ReportBuilder', reportBuilder],
  ] as const) {
    assert.match(source, /createMode/, `${name} must know create mode`)
  }
  assert.match(typeDrawer, /if \(createMode\) return/)
  assert.match(cardStudio, /if \(ro \|\| createMode\) return/)
  assert.match(viewStudio, /if \(createMode\)/)
  assert.match(reportBuilder, /if \(createMode\)/)
  assert.match(
    reportingWidgets,
    /createMode=\{props\.createMode === true\}/,
    'the ViewSpec registry must deliver report create mode to the shared builder',
  )
})

test('create saves send one idempotent POST and check status before parsing', () => {
  for (const [name, source] of [
    ['TypeBuilderDrawer', typeDrawer],
    ['CardStudio', cardStudio],
    ['ViewStudio', viewStudio],
    ['ReportBuilder', reportBuilder],
    ['NewDashboardButton', newDashboardButton],
  ] as const) {
    assert.match(source, /Idempotency-Key/, `${name} must send an idempotency key on Save`)
    assert.match(source, /if \(!res\.ok\)/, `${name} must check the refusal before parsing it`)
  }
  assert.match(typeDrawer, /\/api\/records\/types/)
  assert.match(cardStudio, /\/api\/insights\/cards/)
  assert.match(viewStudio, /fetch\('\/api\/views'/)
  assert.match(reportBuilder, /fetch\('\/api\/reports\/definitions'/)
  assert.equal(
    reportBuilder.match(/fetch\('\/api\/reports\/definitions'/g)?.length,
    1,
    'ReportBuilder must have one explicit create call site',
  )
  assert.match(reportBuilder, /createInFlightRef\.current/, 'ReportBuilder must fence double Save')
})

test('create endpoints require the key, insert once, and audit the insert', () => {
  for (const [name, source] of [
    ['records/types', typesRoute],
    ['insights/cards', cardsRoute],
    ['insights/dashboards', dashboardsRoute],
    ['views', viewsRoute],
    ['reports/definitions', reportsRoute],
  ] as const) {
    assert.match(source, /Idempotency-Key/, `${name} must read the idempotency key`)
    assert.match(source, /invalid_idempotency_key/, `${name} must refuse by name`)
    assert.match(source, /on conflict \(id\) do nothing/, `${name} must not duplicate on retry`)
    assert.match(source, /requestId/, `${name} must hand its key to the audit event`)
    assert.match(source, /status: 409/, `${name} must conflict on key reuse with changes`)
  }
})

test('the audit writer and replay helper persist the snake_case request_id column', () => {
  const audit = read('../../lib/setup/audit.ts')
  const helper = read('../../lib/api/idempotency.ts')
  assert.match(audit, /request_id/, 'auditSetupChange must persist request_id')
  assert.match(helper, /request_id/, 'replay lookup must scope on request_id')
})

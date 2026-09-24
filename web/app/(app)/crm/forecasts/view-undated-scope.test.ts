import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// F3-88: the forecast's "view undated" link dropped the active owner/team
// scope, widening to the whole org while the exclusion count beside it
// stayed scoped. The forecast loader must carry the scope on the link, and
// the opportunities board must honour it. Both halves are loader-proved
// here: the href the forecast emits, and the predicate the board issues.

const OWNER = 'aaaaaaaa-1111-4111-8111-111111111111'
const TEAM = 'bbbbbbbb-2222-4222-8222-222222222222'

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks
  if (!Array.isArray(chunks)) return ''
  return chunks
    .map((c) => {
      if (typeof c === 'string') return c
      const value = (c as { value?: unknown[] })?.value
      if (Array.isArray(value)) return value.map(String).join('')
      if ((c as { queryChunks?: unknown[] })?.queryChunks) return sqlText(c)
      return ''
    })
    .join('')
}

// --- forecasts half -------------------------------------------------------

const forecastStateKey = Symbol.for('openbooks.forecast-undated-scope-test')
interface ForecastState {
  grants: Set<string>
}
const forecastState: ForecastState = { grants: new Set() }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[forecastStateKey] = forecastState

const forecastMocks = new Map<string, string>([
  [
    'mock:authz',
    `
      const state = globalThis[Symbol.for('openbooks.forecast-undated-scope-test')]
      export async function requirePermission() {
        return { user: { orgId: 'org-1', id: 'user-1' }, allowedSubsidiaryIds: null, permissions: [...state.grants] }
      }
      export function can(authz, permission) { return state.grants.has(permission) }
    `,
  ],
  [
    'mock:intl',
    `
      export async function getLocale() { return 'en' }
      export async function getTranslations() { return (key, params) => key }
    `,
  ],
  ['mock:db', `export const db = { async execute() { return { rows: [] } } }`],
  // The clock module is the only business-date import the loader needs from
  // the database (businessToday reads the org timezone); the grid math below
  // mirrors engine/src/platform/business-date.ts (UTC YYYY-MM-DD grid) so
  // the loader's default period resolves without a database.
  [
    'mock:business-date',
    `
      export async function businessToday() { return '2026-08-24' }
      const day = (iso) => {
        if (typeof iso !== 'string' || !/^\\d{4}-\\d{2}-\\d{2}$/.test(iso)) throw new RangeError('bad date')
        const date = new Date(iso + 'T00:00:00.000Z')
        if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso) throw new RangeError('bad date')
        return date
      }
      const isoDay = (date) => date.toISOString().slice(0, 10)
      export function isIsoCalendarDate(value) {
        try { day(value); return true } catch { return false }
      }
      export function startOfMonth(iso) { day(iso); return iso.slice(0, 7) + '-01' }
      export function addCalendarDays(iso, days) {
        const date = day(iso); date.setUTCDate(date.getUTCDate() + days); return isoDay(date)
      }
      export function addCalendarMonthsStart(iso, months) {
        const date = day(iso); date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() + months); return isoDay(date)
      }
    `,
  ],
  [
    'mock:crm',
    `
      export async function calculateForecast() { return [] }
      export async function countUndatedForecastExcluded() { return 3 }
    `,
  ],
  [
    'mock:money',
    `export async function getMoneyFormatter() { return { money: (value) => String(value) } }`,
  ],
  ['mock:tabs', `export async function customerGroupTabs() { return [] }`],
  [
    'mock:viewspec',
    `
      export function badge(label) { return label }
      export function column() { return {} }
      export function field() { return {} }
      export function frame(name, blocks) { return { name, blocks } }
      export function grid(className, blocks) { return { className, blocks } }
      export function money(value) { return value }
      export function page(spec) { return spec }
      export function pageHeader(header) { return header }
      export function ref() { return () => false }
      export function repeat(config) { return config }
      export function rootRef() { return () => false }
      export function table(config) { return config }
      export function text(value) { return value }
      export function widget(kind, props) { return { kind, ...props } }
      export function widgetBlock(kind, props) { return { kind, ...props } }
    `,
  ],
])

const forecastUrls = new Map<string, string>([
  ['../../../../lib/authz', 'mock:authz'],
  ['next-intl/server', 'mock:intl'],
  ['@openbooks/engine/src/platform/db.ts', 'mock:db'],
  ['@openbooks/engine/src/platform/business-date.ts', 'mock:business-date'],
  ['../../../../lib/crm', 'mock:crm'],
  ['../../../../lib/money-server', 'mock:money'],
  ['../../../../components/module-home/group-tabs', 'mock:tabs'],
  ['@braedonsaunders/appkit-viewspec', 'mock:viewspec'],
])

const forecastHooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    }
    const mocked = forecastUrls.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = forecastMocks.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const viewUrl = './view.ts?forecast-undated-scope'
const { loadForecasts } = (await import(viewUrl)) as typeof import('./view.ts')
forecastHooks.deregister()

function forecastScope(owner: string | null, team: string | null) {
  forecastState.grants = new Set(['crm.forecasts.read'])
  const sp: Record<string, string> = {}
  if (owner) sp.owner = owner
  if (team) sp.team = team
  return loadForecasts(sp)
}

test('the undated link carries the active owner scope', async () => {
  const data = await forecastScope(OWNER, null)
  assert.equal(data.hasExcludedUndated, true)
  const href = new URL(data.excludedUndatedHref, 'https://app.test')
  assert.equal(href.pathname, '/crm/opportunities')
  assert.equal(href.searchParams.get('view'), 'board')
  assert.equal(href.searchParams.get('undated'), '1')
  assert.equal(href.searchParams.get('owner'), OWNER)
})

test('the undated link carries the active team scope', async () => {
  const data = await forecastScope(null, TEAM)
  const href = new URL(data.excludedUndatedHref, 'https://app.test')
  assert.equal(href.searchParams.get('team'), TEAM)
  assert.equal(href.searchParams.get('owner'), null)
})

test('owner wins over team on the undated link', async () => {
  const data = await forecastScope(OWNER, TEAM)
  const href = new URL(data.excludedUndatedHref, 'https://app.test')
  assert.equal(href.searchParams.get('owner'), OWNER)
  assert.equal(href.searchParams.get('team'), null)
})

test('the unscoped undated link stays exactly as before', async () => {
  const data = await forecastScope(null, null)
  assert.equal(data.excludedUndatedHref, '/crm/opportunities?view=board&undated=1')
})

// --- opportunities half ---------------------------------------------------

const boardStateKey = Symbol.for('openbooks.opportunity-board-scope-test')
interface BoardState {
  queries: string[]
}
const boardState: BoardState = { queries: [] }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[boardStateKey] = boardState

const OPP_ROW = {
  id: 'op-1',
  opportunity_number: 'OP-1',
  title: 'Scoped deal',
  party_id: null,
  party_name: null,
  primary_contact_id: null,
  contact_name: null,
  owner_user_id: OWNER,
  owner_name: 'Ada',
  sales_team_name: null,
  status_id: 'st-1',
  forecast_category: 'pipeline',
  probability: 50,
  currency: 'USD',
  projected_amount: '1000',
  weighted_amount: '500',
  expected_close_date: null,
  next_step: null,
  win_loss_reason: null,
  updated_at: '2026-01-01T00:00:00Z',
  revision_token: 'rev-1',
  last_activity_at: null,
  lines_count: 0,
}

const STATUS_ROW = {
  id: 'st-1',
  key: 'prospecting',
  name: 'Prospecting',
  sequence: 1,
  probability: 10,
  default_forecast_category: 'pipeline',
  is_closed: false,
  is_won: false,
}

const boardMocks = new Map<string, string>([
  [
    'mock-board:authz',
    `
      export async function requirePermission() {
        return { user: { orgId: 'org-1', id: 'user-1' }, allowedSubsidiaryIds: null, permissions: ['crm.opportunities.read'] }
      }
      export function can() { return false }
    `,
  ],
  [
    'mock-board:intl',
    `export async function getTranslations() { return (key) => key }`,
  ],
  [
    'mock-board:db',
    `
      const state = globalThis[Symbol.for('openbooks.opportunity-board-scope-test')]
      const sqlText = ${sqlText.toString()}
      export const db = {
        async execute(query) {
          const text = sqlText(query)
          state.queries.push(text)
          if (text.includes('from crm_opportunity_statuses')) return { rows: [${JSON.stringify(STATUS_ROW)}] }
          if (text.includes('from crm_opportunities o')) return { rows: [${JSON.stringify(OPP_ROW)}] }
          return { rows: [] }
        },
      }
    `,
  ],
  ['mock-board:features', `export async function isFeatureEnabled() { return false }`],
  // loadOpportunity only runs for an open drawer record; these board tests
  // never pass one, so the stub never fires — it just keeps the real CRM
  // library (and its database imports) out of the module graph.
  ['mock-board:crm-lib', `export async function loadOpportunity() { throw new Error('unexpected drawer load') }`],
  ['mock-board:tabs', `export async function customerGroupTabs() { return [] }`],
  [
    'mock-board:viewspec',
    `
      export function page(spec) { return spec }
      export function pageHeader(header) { return header }
      export function ref() { return () => false }
      export function widget(kind, props) { return { kind, ...props } }
      export function widgetBlock(kind, props) { return { kind, ...props } }
    `,
  ],
])

const boardUrls = new Map<string, string>([
  ['../../../../lib/authz', 'mock-board:authz'],
  ['next-intl/server', 'mock-board:intl'],
  ['@openbooks/engine/src/platform/db.ts', 'mock-board:db'],
  ['../../../../lib/crm', 'mock-board:crm-lib'],
  ['../../../../lib/features', 'mock-board:features'],
  ['../../../../components/module-home/group-tabs', 'mock-board:tabs'],
  ['@braedonsaunders/appkit-viewspec', 'mock-board:viewspec'],
])

const boardHooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    }
    const mocked = boardUrls.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = boardMocks.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const boardViewUrl = '../opportunities/view.ts?board-scope-test'
const { loadOpportunities } = (await import(boardViewUrl)) as typeof import('../opportunities/view.ts')
boardHooks.deregister()

function boardQuery(): string {
  const found = boardState.queries.filter((text) => text.includes('from crm_opportunities o'))
  assert.equal(found.length, 1, 'the board must issue exactly one opportunities query')
  return found[0]!
}

test('the board filters by the carried owner scope', async () => {
  boardState.queries = []
  await loadOpportunities({ view: 'board', undated: '1', owner: OWNER })
  const text = boardQuery()
  assert.ok(text.includes('owner_user_id'), 'the board query must predicate on the owner')
  assert.ok(text.includes(OWNER), 'the board query must carry the owner id')
})

test('the board filters by the carried team scope', async () => {
  boardState.queries = []
  await loadOpportunities({ view: 'board', undated: '1', team: TEAM })
  const text = boardQuery()
  assert.ok(text.includes('sales_team_id'), 'the board query must predicate on the team')
  assert.ok(text.includes(TEAM), 'the board query must carry the team id')
})

test('owner wins over team on the board', async () => {
  boardState.queries = []
  await loadOpportunities({ view: 'board', undated: '1', owner: OWNER, team: TEAM })
  const text = boardQuery()
  assert.ok(text.includes(OWNER), 'the board query must carry the owner id')
  assert.ok(!text.includes(TEAM), 'the team scope must not widen an owner-scoped board')
})

test('a non-uuid scope never reaches the board query', async () => {
  boardState.queries = []
  await loadOpportunities({ view: 'board', undated: '1', owner: 'not-a-uuid', team: 'also-bad' })
  const text = boardQuery()
  assert.ok(!text.includes('not-a-uuid'), 'a malformed owner must not reach the query')
  assert.ok(!text.includes('also-bad'), 'a malformed team must not reach the query')
})

test('the unscoped board issues no owner/team predicate', async () => {
  boardState.queries = []
  await loadOpportunities({ view: 'board', undated: '1' })
  const text = boardQuery()
  // The `and` prefix distinguishes the WHERE predicate from the select list,
  // which always projects o.owner_user_id for the kanban cards.
  assert.ok(!text.includes('and o.owner_user_id'), 'the unscoped board must not predicate on the owner')
  assert.ok(!text.includes('and o.sales_team_id'), 'the unscoped board must not predicate on the team')
})

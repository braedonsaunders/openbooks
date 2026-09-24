import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'

// F3-92: the 1:1 drawer description rendered the stored ISO instant with
// millis (detail.when rode getOneOnOne's scheduledAt verbatim). The loader
// now formats it as an org-zone wall time. America/New_York stands in for
// the org zone: 09:00Z must read 04:00, with no T, zone suffix, or millis.

// Load the REAL zone formatters before the hooks below replace the module:
// the mock isolates only businessTimeZone (the database read); the pure
// formatters stay real so the copy cannot drift from the original.
const realZone = await import('../../../../../engine/src/platform/business-date.ts')

const stateKey = Symbol.for('openbooks.me-one-on-ones-page-test')
const routeState = {
  real: { formatInZone: realZone.formatInZone, formatTimeInZone: realZone.formatTimeInZone },
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState

const hrmCatalog = JSON.parse(readFileSync(new URL('../../../../messages/en/hrm.json', import.meta.url), 'utf8'))
;(globalThis as Record<string, unknown>).__meOneOnOnesCatalog = hrmCatalog

const ONE_ID = '00000000-0000-4000-8000-000000000041'
const SCHEDULED_AT = '2026-01-15T09:00:00.000Z'

const mockSources = new Map<string, string>([
  [
    'mock:authz',
    `export async function getAuthz() { return { user: { id: 'user-1', orgId: 'org-1' } } }`,
  ],
  [
    'mock:features',
    `export async function requireFeatureEnabled() {}`,
  ],
  [
    'mock:self-service',
    `export async function meTabs() { return [] }`,
  ],
  [
    'mock:intl',
    `
      const catalog = globalThis.__meOneOnOnesCatalog
      const lookup = (key) => {
        let node = catalog
        for (const part of key.split('.')) {
          if (node !== null && typeof node === 'object') node = node[part]
          else return key
        }
        return typeof node === 'string' ? node : key
      }
      export async function getTranslations() {
        const t = (key, params) => {
          let template = lookup(key)
          if (params) template = template.replace(/\\{(\\w+)\\}/g, (_, name) => String(params[name] ?? '{' + name + '}'))
          return template
        }
        t.has = (key) => lookup(key) !== key
        return t
      }
    `,
  ],
  [
    'mock:one-on-ones',
    `
      const scheduledAt = globalThis.__meOneOnOnesScheduledAt
      export async function listOneOnOnes() {
        return [
          {
            id: '${ONE_ID}',
            scheduledAt,
            status: 'scheduled',
            managerEmploymentId: 'employment-m',
            reportEmploymentId: 'employment-r',
            managerName: 'Sam Manager',
            reportName: 'Rae Report',
          },
        ]
      }
      export async function getOneOnOne() {
        return { id: '${ONE_ID}', scheduledAt, status: 'scheduled', items: [] }
      }
      export async function listOneOnOneDirectory() {
        return { employments: [] }
      }
    `,
  ],
  [
    'mock:feedback',
    `export async function listOpenRequestsForParty() { return [] }`,
  ],
  [
    'mock:business-date',
    `
      const state = globalThis[Symbol.for('openbooks.me-one-on-ones-page-test')]
      export async function businessTimeZone() { return 'America/New_York' }
      export function formatInZone(date, timeZone) { return state.real.formatInZone(date, timeZone) }
      export function formatTimeInZone(date, timeZone) { return state.real.formatTimeInZone(date, timeZone) }
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['../../../../lib/authz', 'mock:authz'],
  ['../../../../lib/feature-gates', 'mock:features'],
  ['../../../../lib/hrm/self-service', 'mock:self-service'],
  ['next-intl/server', 'mock:intl'],
  ['@openbooks/engine/src/hrm/performance/one-on-ones.ts', 'mock:one-on-ones'],
  ['@openbooks/engine/src/hrm/performance/feedback.ts', 'mock:feedback'],
  ['@openbooks/engine/src/platform/business-date.ts', 'mock:business-date'],
])

registerHooks({
  resolve(specifier, _context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    const mocked = mockUrls.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    return nextResolve(specifier)
  },
  load(url, _context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url)
  },
})

;(globalThis as Record<string, unknown>).__meOneOnOnesScheduledAt = SCHEDULED_AT
const { loadMeOneOnOnesPage } = await import('./view')

test('F3-92: the drawer names the org-zone wall time, never the raw ISO instant', async () => {
  const data = await loadMeOneOnOnesPage({ one: ONE_ID })
  assert.ok(data.detail, 'the drawer detail resolves')
  assert.equal(data.detail.when, '2026-01-15 04:00')
  assert.match(data.detail.when, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, 'no T, zone suffix, or millis')
  assert.ok(data.detail.title.includes('04:00'), 'the drawer title agrees with the description')
})

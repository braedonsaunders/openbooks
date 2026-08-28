import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const stateKey = Symbol.for('openbooks.accounting-home-scope-test')
interface State {
  calls: string[]
  emptyScope: boolean
}
const state: State = { calls: [], emptyScope: false }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks
  if (!Array.isArray(chunks)) return ''
  return chunks.map((chunk) => {
    if (typeof chunk === 'string') return chunk
    const value = (chunk as { value?: unknown[] })?.value
    if (Array.isArray(value)) return value.map(String).join('')
    if ((chunk as { queryChunks?: unknown[] })?.queryChunks) return sqlText(chunk)
    return ''
  }).join('')
}
;(globalThis as typeof globalThis & Record<string, unknown>).openbooksSqlTextAccounting = sqlText

const mockSources = new Map<string, string>([
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.accounting-home-scope-test')]
      const sqlText = globalThis.openbooksSqlTextAccounting
      export const db = {
        execute: async (query) => {
          const text = sqlText(query)
          state.calls.push(text)
          if (text.includes('from close_runs')) {
            return state.emptyScope ? { rows: [] } : { rows: [{ id: 'run-1', status: 'in_progress', period_name: 'August', tasks_total: '4', tasks_done: '2' }] }
          }
          if (text.includes('from ai_work_items')) {
            return state.emptyScope ? { rows: [] } : { rows: [{ severity: 'warning', n: '3' }] }
          }
          if (text.includes('from journal_entries je')) {
            return state.emptyScope
              ? { rows: [{ draft_journals: '0', posted_7d: '0', accounts: '0', budgets: '0', assets: '0' }] }
              : { rows: [{ draft_journals: '2', posted_7d: '5', accounts: '7', budgets: '1', assets: '3' }] }
          }
          return { rows: [] }
        },
      }
      export const schema = {}
      export async function withBypassContext(work) { return work() }
    `,
  ],
  ['mock:business-date', `export async function businessToday() { return '2026-08-28' }; export function addCalendarDays(date, days) { return date }`],
  ['mock:authz', `export async function getAuthz() { throw new Error('explicit scope should not resolve request authz') }`],
])

const mockUrls = new Map<string, string>([
  ['@openbooks/engine/src/db.ts', 'mock:db'],
  ['@openbooks/engine/src/business-date.ts', 'mock:business-date'],
  ['../authz', 'mock:authz'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    const mocked = mockUrls.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const accountingUrl = './accounting.ts?scope-contract'
const { accountingHome } = (await import(accountingUrl)) as typeof import('./accounting.ts')
hooks.deregister()

function reset(emptyScope = false): void {
  state.calls.length = 0
  state.emptyScope = emptyScope
}

test('unrestricted Accounting home remains tenant-wide', async () => {
  reset()
  const home = await accountingHome('org-1', null)
  assert.equal(home.draftJournals, 2)
  assert.equal(home.badges.assets, 3)
  assert.ok(state.calls.every((query) => !query.includes('and false')))
  assert.ok(state.calls.some((query) => query.includes('from close_runs')))
})

test('restricted Accounting home scopes legal-entity metrics and fails closed for unscoped badges', async () => {
  reset()
  const home = await accountingHome('org-1', new Set(['sub-a', 'sub-b']))
  assert.equal(home.draftJournals, 2)
  assert.equal(home.badges.assets, 3)
  const all = state.calls.join('\n')
  assert.match(all, /je\.subsidiary_id = any/)
  assert.match(all, /f\.subsidiary_id = any/)
  assert.match(all, /a\.subsidiary_id is null or a\.subsidiary_id = any/)
  assert.match(all, /jsonb_array_elements_text/)
  assert.match(all, /from budget_scenarios[\s\S]*budget_lines[\s\S]*not exists/)
  assert.match(all, /from ai_work_items[\s\S]*subject_type[\s\S]*subsidiary_id/)
})

test('empty subsidiary scope returns no Accounting home metrics', async () => {
  reset(true)
  const home = await accountingHome('org-1', new Set())
  assert.equal(home.close.runId, null)
  assert.equal(home.draftJournals, 0)
  assert.equal(home.postedJournals7d, 0)
  assert.deepEqual(home.workItems, { critical: 0, warning: 0, info: 0, total: 0 })
  assert.deepEqual(home.badges, { accounts: 0, budgets: 0, assets: 0 })
  assert.ok(state.calls.every((query) => query.includes('and false')))
})

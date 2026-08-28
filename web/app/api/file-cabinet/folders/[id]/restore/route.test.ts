import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// This route test runs the real restore helper and audit writer against a
// transaction-aware in-memory database seam. It exercises the same production
// call graph without requiring a live Postgres instance.
const stateKey = Symbol.for('openbooks.folder-restore-route-test')
const ORG_ID = '00000000-0000-4000-8000-00000000d001'
const ACTOR_ID = '00000000-0000-4000-8000-00000000d002'
const FOLDER_ID = '00000000-0000-4000-8000-00000000d003'
const CHILD_FOLDER_ID = '00000000-0000-4000-8000-00000000d004'
const FILE_ID = '00000000-0000-4000-8000-00000000d005'

interface RouteState {
  folders: Record<string, boolean>
  files: Record<string, boolean>
  committedAudit: string[]
  executed: Array<{ kind: 'db' | 'tx'; text: string }>
  failAudit: boolean
  transactionCount: number
}

const routeState: RouteState = {
  folders: {},
  files: {},
  committedAudit: [],
  executed: [],
  failAudit: false,
  transactionCount: 0,
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState

/** Flatten a drizzle SQL value for assertions and scripted responses. */
function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks
  if (!Array.isArray(chunks)) return ''
  return chunks
    .map((chunk) => {
      if (typeof chunk === 'string') return chunk
      const value = (chunk as { value?: unknown[] })?.value
      if (Array.isArray(value)) return value.map(String).join('')
      if ((chunk as { queryChunks?: unknown[] })?.queryChunks) return sqlText(chunk)
      return ''
    })
    .join('')
}
;(globalThis as typeof globalThis & Record<string, unknown>).openbooksSqlTextFolderRestore = sqlText

const mockSources = new Map<string, string>([
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.folder-restore-route-test')]
      const sqlText = globalThis.openbooksSqlTextFolderRestore
      const clone = (value) => ({ ...value })
      const execute = (target, kind, query) => {
        const text = sqlText(query)
        state.executed.push({ kind, text })
        if (text.includes('select f.id, f.is_inactive')) {
          return Promise.resolve({ rows: Object.entries(target.folders)
            .map(([id, isInactive]) => ({ id, isInactive })) })
        }
        if (text.includes('select fi.id, fi.is_inactive')) {
          return Promise.resolve({ rows: Object.entries(target.files)
            .map(([id, isInactive]) => ({ id, isInactive })) })
        }
        if (text.includes('update folders')) {
          for (const id of Object.keys(target.folders)) target.folders[id] = false
          return Promise.resolve({ rows: [] })
        }
        if (text.includes('update files')) {
          for (const id of Object.keys(target.files)) target.files[id] = false
          return Promise.resolve({ rows: [] })
        }
        if (text.includes('insert into audit_log')) {
          if (state.failAudit) throw new Error('forced audit failure')
          target.audit.push(text)
          return Promise.resolve({ rows: [] })
        }
        return Promise.resolve({ rows: [] })
      }
      const db = {
        execute: (query) => execute({ folders: state.folders, files: state.files, audit: [] }, 'db', query),
        transaction: async (work) => {
          state.transactionCount++
          const target = {
            folders: clone(state.folders),
            files: clone(state.files),
            audit: [],
          }
          const tx = { execute: (query) => execute(target, 'tx', query) }
          try {
            const result = await work(tx)
            Object.assign(state.folders, target.folders)
            Object.assign(state.files, target.files)
            state.committedAudit.push(...target.audit)
            return result
          } finally {
            // A rejected unit intentionally discards target's pending writes.
          }
        },
      }
      export { db }
      export async function inDbTransaction(work) { return db.transaction(work) }
      export const env = {}
      export const schema = {}
      export const pool = {}
      export async function withOrg(_orgId, work) { return work() }
      export async function withOrgContext(_orgId, work) { return work() }
      export async function withBypass(work) { return work() }
      export async function withBypassContext(_opts, work) { return work() }
      export function registerRequestOrgResolver() {}
    `,
  ],
  [
    'mock:folder-route-lib',
    `
      export async function requireSession() {
        return { user: { orgId: '${ORG_ID}', id: '${ACTOR_ID}' } }
      }
      export async function requireFolderAccess() { return null }
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['@openbooks/engine/src/db.ts', 'mock:db'],
  ['../../../lib', 'mock:folder-route-lib'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
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

const routeUrl = './route.ts?folder-restore-route-test'
const { POST } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function reset(): void {
  routeState.folders = { [FOLDER_ID]: true, [CHILD_FOLDER_ID]: true }
  routeState.files = { [FILE_ID]: true }
  routeState.committedAudit = []
  routeState.executed = []
  routeState.failAudit = false
  routeState.transactionCount = 0
}

function post(): Promise<Response> {
  return POST(
    new Request(`http://openbooks.test/api/file-cabinet/folders/${FOLDER_ID}/restore`, { method: 'POST' }),
    { params: Promise.resolve({ id: FOLDER_ID }) },
  )
}

test('successful restore commits the subtree and actor-attributed before/after evidence together', async () => {
  reset()

  const response = await post()

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
  assert.deepEqual(routeState.folders, { [FOLDER_ID]: false, [CHILD_FOLDER_ID]: false })
  assert.deepEqual(routeState.files, { [FILE_ID]: false })
  assert.equal(routeState.transactionCount, 1, 'restore and evidence share one transaction')

  const audit = routeState.committedAudit[0]
  assert.ok(audit, 'successful restore leaves durable audit evidence')
  assert.match(audit, /insert into audit_log/)
  assert.match(audit, new RegExp(ACTOR_ID), 'evidence preserves the actor')
  assert.match(audit, /now\(\)/, 'evidence gets its immutable database timestamp')
  assert.match(audit, /"event":"restore"/)
  assert.match(audit, /"before":/, 'evidence preserves the pre-restore state')
  assert.match(audit, /"after":/, 'evidence preserves the post-restore state')
  assert.ok(routeState.executed.every((call) => call.kind === 'tx'), 'all mutation and audit statements use the transaction executor')
})

test('injected audit failure rolls back the entire restore with zero committed state', async () => {
  reset()
  routeState.failAudit = true

  await assert.rejects(() => post(), /forced audit failure/)

  assert.deepEqual(routeState.folders, { [FOLDER_ID]: true, [CHILD_FOLDER_ID]: true }, 'folder restore is rolled back')
  assert.deepEqual(routeState.files, { [FILE_ID]: true }, 'contained file restore is rolled back')
  assert.deepEqual(routeState.committedAudit, [], 'failed evidence leaves no committed audit row')
  assert.equal(routeState.transactionCount, 1)
  assert.ok(routeState.executed.some((call) => call.text.includes('update folders')), 'restore was attempted inside the transaction')
})

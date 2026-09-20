import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// PATCH used to drop a whitespace-only name after trim and report
// {ok:true, changed:false} (or apply sibling fields). Collection POST
// already refuses !body.name?.trim(); this is the member-route counterpart.
// Authz, gates, and the database are stubbed — never parseJsonBody.

const stateKey = Symbol.for('openbooks.form-layout-empty-name-patch-test')
interface RouteState {
  writes: string[]
  loadRow: Record<string, unknown> | null
}
const state: RouteState = { writes: [], loadRow: null }
;(globalThis as Record<symbol, unknown>)[stateKey] = state

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks
  if (!Array.isArray(chunks)) return String(query ?? '')
  return chunks
    .map((chunk) => {
      if (typeof chunk === 'string') return chunk
      if ((chunk as { queryChunks?: unknown[] })?.queryChunks) return sqlText(chunk)
      return ''
    })
    .join('')
}
;(globalThis as Record<string, unknown>).openbooksSqlTextFormEmptyName = sqlText

const mockAuthz = `
  export async function guardPermission() {
    return { user: { orgId: 'org-1', id: 'user-1' } }
  }
`
const mockGates = `
  export async function refuseDisabledRecordType() {
    return null
  }
`
const mockDb = `
  const state = globalThis[Symbol.for('openbooks.form-layout-empty-name-patch-test')]
  const sqlText = globalThis.openbooksSqlTextFormEmptyName
  function noteWrite(query) {
    const text = sqlText(query)
    if (/\\bupdate\\b/i.test(text) || /\\binsert\\b/i.test(text) || /\\bdelete\\b/i.test(text)) {
      state.writes.push(text)
    }
  }
  const executor = {
    async execute(query) {
      noteWrite(query)
      return { rows: state.loadRow ? [state.loadRow] : [] }
    },
  }
  export const db = {
    ...executor,
    async transaction(work) {
      state.writes.push('transaction')
      return work(executor)
    },
  }
`

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (specifier.startsWith('@/')) {
      return nextResolve(
        new URL(`../../../../../../web/${specifier.slice(2)}.ts`, import.meta.url).href,
        context,
      )
    }
    const parent = context.parentURL ?? ''
    if (specifier === '@openbooks/engine/src/platform/db.ts' && parent.includes('customization/form-layouts')) {
      return { shortCircuit: true, format: 'module', url: 'mock:form-empty-name-db' }
    }
    if (
      (specifier.endsWith('lib/authz') || specifier.endsWith('lib/customization/gates')) &&
      parent.includes('customization/form-layouts')
    ) {
      return {
        shortCircuit: true,
        format: 'module',
        url: specifier.endsWith('lib/authz') ? 'mock:form-empty-name-authz' : 'mock:form-empty-name-gates',
      }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:form-empty-name-authz') return { format: 'module', source: mockAuthz, shortCircuit: true }
    if (url === 'mock:form-empty-name-gates') return { format: 'module', source: mockGates, shortCircuit: true }
    if (url === 'mock:form-empty-name-db') return { format: 'module', source: mockDb, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const LAYOUT_ID = '22222222-2222-4222-8222-222222222222'
const form_layout_empty_name_patchUrl = './route.ts?form-layout-empty-name-patch'
const { PATCH } = (await import(form_layout_empty_name_patchUrl)) as typeof import('./route.ts')
hooks.deregister()

state.loadRow = {
  id: LAYOUT_ID,
  recordType: 'vendor_bill',
  name: 'Standard',
  description: null,
  isDefault: false,
  isActive: true,
  allowedRoles: null,
  layout: {},
}

function patch(body: unknown): Promise<Response> {
  return PATCH(
    new Request(`http://x/api/customization/form-layouts/${LAYOUT_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: LAYOUT_ID }) },
  )
}

test('form-layouts PATCH refuses a whitespace-only name instead of {ok:true} or a write', async () => {
  state.writes = []
  const res = await patch({ name: '   ' })
  assert.equal(res.status, 400)
  const body = (await res.json()) as { error?: string; ok?: boolean; changed?: boolean }
  assert.match(String(body.error), /name cannot be empty/)
  assert.notEqual(body.ok, true)
  assert.deepEqual(state.writes, [], 'a blank name must not update form_layouts or write audit')
})

test('form-layouts PATCH refuses a whitespace name even when sibling fields are present', async () => {
  state.writes = []
  const res = await patch({ name: '   ', isActive: false })
  assert.equal(res.status, 400)
  assert.match(String((await res.json()).error), /name cannot be empty/)
  assert.deepEqual(state.writes, [], 'sibling fields must not commit when the name is blank')
})

import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// H-CREWPOST: POST /api/time/crew-batches/[id] {action: 'post'} gated only
// time.manage, then postBatch created APPROVED project_charge documents and
// the route posted each to the GL — a time manager without gl.post posted
// equipment charges, bypassing the posting duty. Posting now takes the
// kind's postPermission (gl.post, the same map the generic actions route
// enforces), refused by name BEFORE postBatch commits anything.
interface CrewState {
  allowPost: boolean
  postBatchCalls: number
  postedDocuments: string[]
}

const stateKey = Symbol.for('openbooks.crew-batch-post-test')
const crewState: CrewState = { allowPost: true, postBatchCalls: 0, postedDocuments: [] }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = crewState

const BATCH_ID = '00000000-0000-4000-8000-00000000d001'
const CHARGE_ID = '00000000-0000-4000-8000-00000000d002'

const mockSources = new Map<string, string>([
  [
    'mock:feature-gates',
    `
      const state = globalThis[Symbol.for('openbooks.crew-batch-post-test')]
      export async function guardFeaturePermission() {
        return { user: { orgId: 'org-1', id: 'user-1' }, allowedSubsidiaryIds: null }
      }
    `,
  ],
  [
    'mock:authz',
    `
      const state = globalThis[Symbol.for('openbooks.crew-batch-post-test')]
      // Authorization-check double: time.manage always holds; gl.post only
      // while the posting case runs.
      export function can(authz, perm) {
        if (perm === 'gl.post') return state.allowPost
        return true
      }
    `,
  ],
  [
    'mock:crew',
    `
      const state = globalThis[Symbol.for('openbooks.crew-batch-post-test')]
      export async function approveBatchStage() { throw new Error('not under test') }
      export async function postBatch() {
        state.postBatchCalls += 1
        return { chargeDocumentIds: ['${CHARGE_ID}'] }
      }
      export async function rejectBatch() { throw new Error('not under test') }
      export async function setBatchLines() { throw new Error('not under test') }
      export async function submitBatch() { throw new Error('not under test') }
      export async function withdrawBatch() { throw new Error('not under test') }
    `,
  ],
  [
    'mock:reads',
    `
      export async function getBatchDetail() { return { id: '${BATCH_ID}' } }
    `,
  ],
  [
    'mock:posting',
    `
      const state = globalThis[Symbol.for('openbooks.crew-batch-post-test')]
      export async function postDocument(documentId) {
        state.postedDocuments.push(documentId)
        return 'entry-1'
      }
    `,
  ],
  [
    'mock:payments',
    `
      export async function paymentControlDeps() { return {} }
    `,
  ],
  [
    'mock:json',
    `
      export const jsonObject = {}
      export async function parseJsonBody(request) {
        return { ok: true, data: await request.json() }
      }
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['@/lib/api/json', 'mock:json'],
  ['../../../../../lib/authz', 'mock:authz'],
  ['../../../../../lib/feature-gates', 'mock:feature-gates'],
  ['@openbooks/engine/src/ledger/posting-document.ts', 'mock:posting'],
  ['@openbooks/engine/src/payments/payment-accounts.ts', 'mock:payments'],
  ['@openbooks/engine/src/hrm/field-time/crew.ts', 'mock:crew'],
  ['@openbooks/engine/src/hrm/field-time/reads.ts', 'mock:reads'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { format: 'module', source: '', shortCircuit: true, url: 'mock:server-only' }
    const mocked = mockUrls.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    if (url === 'mock:server-only') return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?crew-batch-post-test'
const { POST } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function postBatchAction(): Promise<Response> {
  return POST(
    new Request(`http://openbooks.test/api/time/crew-batches/${BATCH_ID}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'post' }),
    }),
    { params: Promise.resolve({ id: BATCH_ID }) },
  )
}

function reset(allowPost: boolean): void {
  crewState.allowPost = allowPost
  crewState.postBatchCalls = 0
  crewState.postedDocuments = []
}

test('post without gl.post is refused by name before anything commits', async () => {
  reset(false)
  const response = await postBatchAction()
  assert.equal(response.status, 403)
  assert.deepEqual(await response.json(), { error: 'missing permission: gl.post' })
  assert.equal(crewState.postBatchCalls, 0)
  assert.deepEqual(crewState.postedDocuments, [])
})

test('post with gl.post creates and posts the charges as before', async () => {
  reset(true)
  const response = await postBatchAction()
  assert.equal(response.status, 200)
  assert.equal(crewState.postBatchCalls, 1)
  assert.deepEqual(crewState.postedDocuments, [CHARGE_ID])
})

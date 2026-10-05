import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { NextResponse } from 'next/server'

const stateKey = Symbol.for('openbooks.item-family-routes-test')

interface State {
  featureEnabled: boolean
  engineCalls: string[]
  respond: typeof NextResponse
}

const state: State = { featureEnabled: true, engineCalls: [], respond: NextResponse }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

const ORG_ID = '00000000-0000-4000-8000-00000000c101'
const ACTOR_ID = '00000000-0000-4000-8000-00000000c102'

const mockSources = new Map<string, string>([
  ['mock:feature-gates', `
    const state = globalThis[Symbol.for('openbooks.item-family-routes-test')]
    export async function guardFeaturePermission() {
      if (!state.featureEnabled) return state.respond.json({ error: 'not_found' }, { status: 404 })
      return { user: { orgId: '${ORG_ID}', id: '${ACTOR_ID}' }, allowedSubsidiaryIds: null }
    }
  `],
  ['mock:families', `
    const state = globalThis[Symbol.for('openbooks.item-family-routes-test')]
    export async function createItemFamily() { state.engineCalls.push('createItemFamily'); throw new Error('engine must not run while the feature is off') }
    export async function generateFamilyVariants() { state.engineCalls.push('generateFamilyVariants'); throw new Error('engine must not run while the feature is off') }
    export async function previewGenerateVariants() { state.engineCalls.push('previewGenerateVariants'); throw new Error('engine must not run while the feature is off') }
  `],
])

const mockUrls = new Map<string, string>([
  ['@/lib/feature-gates', 'mock:feature-gates'],
  ['@openbooks/engine/inventory', 'mock:families'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const mocked = mockUrls.get(specifier)
    if (mocked) return { shortCircuit: true, url: mocked }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const createUrl = './route.ts?family-routes-test'
const generateUrl = './[id]/generate/route.ts?family-routes-test'
const { POST: createFamily } = (await import(createUrl)) as typeof import('./route.ts')
const { POST: generateVariants } = (await import(generateUrl)) as typeof import('./[id]/generate/route.ts')
test.after(() => test.after(() => hooks.deregister()))

function reset(): void {
  state.featureEnabled = false
  state.engineCalls.length = 0
}

test('POST /api/item-families with the feature off is refused before any write', async () => {
  reset()
  const response = await createFamily(new Request('http://openbooks.test/api/item-families', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'TEE', name: 'Classic Tee', kind: 'inventory', options: [{ name: 'Size', values: ['S'] }] }),
  }))

  assert.equal(response.status, 404)
  assert.deepEqual(state.engineCalls, [])
})

test('POST /api/item-families/[id]/generate with the feature off is refused before any write', async () => {
  reset()
  const familyId = '00000000-0000-4000-8000-00000000c103'
  const response = await generateVariants(
    new Request(`http://openbooks.test/api/item-families/${familyId}/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }),
    { params: Promise.resolve({ id: familyId }) },
  )

  assert.equal(response.status, 404)
  assert.deepEqual(state.engineCalls, [])
})

test('the mocked gate is honest: it passes when the feature is on', async () => {
  reset()
  state.featureEnabled = true
  await assert.rejects(
    createFamily(new Request('http://openbooks.test/api/item-families', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'TEE', name: 'Classic Tee', kind: 'inventory', options: [{ name: 'Size', values: ['S'] }] }),
    })),
    /engine must not run while the feature is off/,
  )
  assert.deepEqual(state.engineCalls, ['createItemFamily'])
})

import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// OM-14: when provisioning fails mid-pipeline, POST /api/data/sample-companies
// must return the NAMED stage refusal (stable code + operator-facing message)
// — never a generic 500, and never SQL text or internal detail in the body.

const stateKey = Symbol.for('openbooks.sample-companies-route-test')
const routeState = { calls: [] as unknown[], failClone: false }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState

const failuresUrl = new URL(
  '../../../../../engine/src/sample-companies/provisioning-failures.ts',
  import.meta.url,
).href

const mockSources = new Map<string, string>([
  [
    'mock:json',
    `
      export const jsonObject = {}
      export async function parseJsonBody(request) {
        return { ok: true, data: await request.json() }
      }
    `,
  ],
  [
    'mock:authz',
    `
      export async function getAuthz() {
        return { user: { homeUserId: 'user-1', orgId: 'org-1', name: 'Sara Lindqvist' } }
      }
      export function can() {
        return true
      }
    `,
  ],
  [
    'mock:features',
    `
      export const FEATURES = [{ key: 'projects', defaultEnabled: true }]
      export function featureRequirements() {
        return []
      }
    `,
  ],
  [
    'mock:industries',
    `
      export const INDUSTRY_BY_KEY = new Map([['sim_atlas', { features: {} }]])
    `,
  ],
  [
    '@openbooks/engine/src/sample-companies/service.ts',
    `
      export {
        SampleCompanyError,
        SampleCompanyProvisioningError,
        sampleCompanyStageMessage,
        SAMPLE_COMPANY_STAGE_CODES,
      } from '${failuresUrl}'
      import { runProvisioningStage } from '${failuresUrl}'
      const state = globalThis[Symbol.for('openbooks.sample-companies-route-test')]
      export async function sampleCompanyStatuses() {
        return []
      }
      export async function createSampleCompany(input) {
        state.calls.push(input)
        if (state.failClone) {
          // Induce the failure the way the service reports it: the clone
          // step throws a raw database error and the real stage wrapper
          // converts it into the named clone refusal.
          await runProvisioningStage('clone', async () => {
            throw new Error(
              'duplicate key value violates unique constraint "orgs_pkey" ' +
              'STATEMENT: INSERT INTO orgs (id, name) VALUES ($1, $2)',
            )
          })
        }
        return { orgId: 'org-new', name: 'SIM Atlas', created: true, templateGenerated: false }
      }
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['@/lib/api/json', 'mock:json'],
  ['@openbooks/engine/src/sample-companies/service.ts', '@openbooks/engine/src/sample-companies/service.ts'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const mocked = mockUrls.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    if (specifier.endsWith('lib/authz')) return { url: 'mock:authz', shortCircuit: true }
    if (specifier.endsWith('lib/features')) return { url: 'mock:features', shortCircuit: true }
    if (specifier.endsWith('lib/industries')) return { url: 'mock:industries', shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?sample-companies-stage-refusal-test'
const { POST } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function post(body: unknown): Promise<Response> {
  return POST(
    new Request('http://openbooks.test/api/data/sample-companies', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

test('a clone-stage database failure returns the named stage refusal without SQL text', async () => {
  routeState.calls = []
  routeState.failClone = true
  try {
    const response = await post({ industry: 'sim_atlas' })
    assert.equal(response.status, 500)
    const body = (await response.json()) as Record<string, unknown>
    assert.equal(body.error, 'sample-company-clone-failed')
    assert.equal(body.stage, 'clone')
    assert.match(String(body.message), /copying the template's posted history failed/)
    assert.match(String(body.message), /Nothing was created; you can retry/)
    for (const leak of ['duplicate key', 'unique constraint', 'orgs_pkey', 'INSERT', 'STATEMENT', 'VALUES']) {
      assert.doesNotMatch(
        JSON.stringify(body),
        new RegExp(leak.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
        `the response body must not leak ${JSON.stringify(leak)}`,
      )
    }
  } finally {
    routeState.failClone = false
  }
})

test('a successful provision still returns the new company', async () => {
  routeState.calls = []
  const response = await post({ industry: 'sim_atlas' })
  assert.equal(response.status, 200)
  const body = (await response.json()) as Record<string, unknown>
  assert.equal(body.ok, true)
  assert.equal(body.orgId, 'org-new')
})

test('an unknown industry stays a 422 refusal', async () => {
  const response = await post({ industry: 'no_such_industry' })
  assert.equal(response.status, 422)
  const body = (await response.json()) as Record<string, unknown>
  assert.equal(body.error, 'unknown-industry')
})

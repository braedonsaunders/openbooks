import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const stateKey = Symbol.for('openbooks.recognition-preview-route-test')
const state: {
  allowedSubsidiaryIds: Set<string> | null
  previewError: { kind: 'domain' | 'unexpected'; message: string } | null
} = {
  allowedSubsidiaryIds: null,
  previewError: null,
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

const mockSources = new Map<string, string>([
  [
    'authz',
    `
      const state = globalThis[Symbol.for('openbooks.recognition-preview-route-test')]
      export async function guardPermission() {
        return {
          user: { orgId: 'org-1', id: 'user-1' },
          allowedSubsidiaryIds: state.allowedSubsidiaryIds,
        }
      }
    `,
  ],
  [
    'features',
    `export async function isFeatureEnabled() { return true }`,
  ],
  [
    'business-date',
    `
      export async function businessToday() { return '2026-08-31' }
      export function isIsoCalendarDate(value) { return /^\\d{4}-\\d{2}-\\d{2}$/.test(value ?? '') }
    `,
  ],
  [
    'revenue-recognition',
    `
      const state = globalThis[Symbol.for('openbooks.recognition-preview-route-test')]
      export class RevenueRecognitionError extends Error {}
      export class StaleRecognitionPreviewError extends Error {}
      // Scope attribution surface used by ownedId; these tests never pass
      // ids, so the lookups below never run — the stubs only satisfy the
      // static import.
      export async function obligationAttribution() { return null }
      export async function revenueContractAttribution() { return null }
      export async function previewRevenueRecognition(_orgId, _input) {
        if (state.previewError) {
          if (state.previewError.kind === 'domain') throw new RevenueRecognitionError(state.previewError.message)
          throw new Error(state.previewError.message)
        }
        return {
          asOfDate: '2026-08-31',
          rows: [],
          postableCount: 0,
          skippedCount: 0,
          totalAmount: '0',
          totalDebits: '0',
          totalCredits: '0',
          balanced: true,
          projectSyncPending: false,
          warnings: [],
          fingerprint: 'preview-fingerprint',
        }
      }
    `,
  ],
])

const selfUrl = new URL(import.meta.url).href
const mockUrl = (name: string) => `${selfUrl}?preview-mock=${name}`
const mockUrls = new Map<string, string>([
  ['../../../../lib/authz', mockUrl('authz')],
  ['../../../../lib/features', mockUrl('features')],
  ['@openbooks/engine/src/platform/business-date.ts', mockUrl('business-date')],
  ['@openbooks/engine/src/revenue/recognition.ts', mockUrl('revenue-recognition')],
  // The shared error mapper reaches the same engine module through a
  // relative specifier; it must see the same double or instanceof splits.
  ['../../engine/src/revenue/recognition.ts', mockUrl('revenue-recognition')],
])

const hooks = registerHooks({
  resolve(specifier, _context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    const mocked = mockUrls.get(specifier)
    if (mocked) return { shortCircuit: true, url: mocked }
    return nextResolve(specifier, _context)
  },
  load(url, context, nextLoad) {
    const name = new URL(url).searchParams.get('preview-mock')
    const source = name ? mockSources.get(name) : undefined
    if (source !== undefined) return { shortCircuit: true, format: 'module', source }
    return nextLoad(url, context)
  },
})

const routeUrl = new URL('./route.ts?recognition-preview-test', import.meta.url).href
const { POST } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function reset(): void {
  state.allowedSubsidiaryIds = null
  state.previewError = null
}

function post(body: unknown): Promise<Response> {
  return POST(
    new Request('http://openbooks.test/api/revenue/recognition-preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

test('a domain refusal from the preview reaches the operator as a named 422, not a 500', async () => {
  reset()
  state.previewError = { kind: 'domain', message: 'January 2026: GL period closed' }

  const response = await post({})

  assert.equal(response.status, 422)
  assert.deepEqual(await response.json(), { error: 'January 2026: GL period closed' })
})

test('an unexpected preview defect stays a generic 500', async () => {
  reset()
  state.previewError = { kind: 'unexpected', message: 'connection terminated' }

  const response = await post({})

  assert.equal(response.status, 500)
  assert.deepEqual(await response.json(), { error: 'Unable to preview revenue recognition.' })
})

test('a clean preview passes through with its fingerprint', async () => {
  reset()

  const response = await post({})

  assert.equal(response.status, 200)
  const body = (await response.json()) as { fingerprint: string; totalAmount: string }
  assert.equal(body.fingerprint, 'preview-fingerprint')
  assert.equal(body.totalAmount, '0')
})

import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

type Scope = string[] | undefined

interface RouteState {
  allowedSubsidiaryIds: Set<string> | null
  projectsEnabled: boolean
  syncCalls: { scope: Scope; syncedProjectIds: string[] }[]
  runCalls: { scope: Scope; postedProjectIds: string[] }[]
  runError: { kind: 'domain' | 'stale' | 'unexpected'; message: string } | null
  syncSkipped: string | null
}

const stateKey = Symbol.for('openbooks.recognition-route-test')
const state: RouteState = {
  allowedSubsidiaryIds: null,
  projectsEnabled: true,
  syncCalls: [],
  runCalls: [],
  runError: null,
  syncSkipped: null,
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

const projects = [
  { id: 'project-visible', subsidiaryId: 'subsidiary-visible' },
  { id: 'project-hidden', subsidiaryId: 'subsidiary-hidden' },
]

const mockSources = new Map<string, string>([
  [
    'authz',
    `
      const state = globalThis[Symbol.for('openbooks.recognition-route-test')]
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
    `
      const state = globalThis[Symbol.for('openbooks.recognition-route-test')]
      export async function isFeatureEnabled(_orgId, feature) {
        return feature === 'projects' ? state.projectsEnabled : true
      }
    `,
  ],
  [
    'business-date',
    `export async function businessToday() { return '2026-08-31' }`,
  ],
  [
    'json',
    `
      import { NextResponse } from 'next/server'
      import { z } from 'zod'
      export const uuidId = z.string()
      export function isoDate() { return z.string().regex(/^\\d{4}-\\d{2}-\\d{2}$/) }
      export async function parseJsonBody(req, schema, opts) {
        const raw = await req.json().catch(() => undefined)
        const parsed = schema.safeParse(raw)
        if (!parsed.success) return { ok: false, response: NextResponse.json({ error: 'invalid request body' }, { status: opts?.status ?? 400 }) }
        return { ok: true, data: parsed.data }
      }
    `,
  ],
  [
    'project-revenue',
    `
      const state = globalThis[Symbol.for('openbooks.recognition-route-test')]
      const projects = ${JSON.stringify(projects)}
      export async function syncProjectRevenueContracts(_orgId, _actorId, _asOfDate, _projectId, allowedSubsidiaryIds) {
        const visible = allowedSubsidiaryIds == null
          ? projects
          : projects.filter((project) => allowedSubsidiaryIds.includes(project.subsidiaryId))
        state.syncCalls.push({ scope: allowedSubsidiaryIds == null ? undefined : [...allowedSubsidiaryIds], syncedProjectIds: visible.map((project) => project.id) })
        return { synced: [], problems: [], skipped: state.syncSkipped }
      }
    `,
  ],
  [
    'revenue-recognition',
    `
      const state = globalThis[Symbol.for('openbooks.recognition-route-test')]
      const projects = ${JSON.stringify(projects)}
      export class RevenueRecognitionError extends Error {}
      export async function runRevenueRecognition(_orgId, _asOfDate, _actorId, _obligationId, allowedSubsidiaryIds) {
        if (state.runError) {
          if (state.runError.kind === 'domain') throw new RevenueRecognitionError(state.runError.message)
          if (state.runError.kind === 'stale') throw new StaleRecognitionPreviewError(state.runError.message)
          throw new Error(state.runError.message)
        }
        const visible = allowedSubsidiaryIds == null
          ? projects
          : projects.filter((project) => allowedSubsidiaryIds.includes(project.subsidiaryId))
        state.runCalls.push({ scope: allowedSubsidiaryIds == null ? undefined : [...allowedSubsidiaryIds], postedProjectIds: visible.map((project) => project.id) })
        return { posted: visible.length, skipped: 0, totalAmount: '0', entries: [], problems: [] }
      }
      // The route maps the stale-confirmation class to 409; the double
      // stands in for the whole module, so it must offer it too.
      export class StaleRecognitionPreviewError extends Error {}
    `,
  ],
])

const selfUrl = new URL(import.meta.url).href
const mockUrl = (name: string) => `${selfUrl}?recognition-mock=${name}`
const mockUrls = new Map<string, string>([
  ['../../../../lib/authz', mockUrl('authz')],
  ['../../../../lib/features', mockUrl('features')],
  ['@openbooks/engine/src/platform/business-date.ts', mockUrl('business-date')],
  ['@openbooks/engine/src/projects/revenue.ts', mockUrl('project-revenue')],
  ['@openbooks/engine/src/revenue/recognition.ts', mockUrl('revenue-recognition')],
  // The shared error mapper reaches the same engine module through a
  // relative specifier; it must see the same double or instanceof splits.
  ['../../engine/src/revenue/recognition.ts', mockUrl('revenue-recognition')],
  ['@/lib/api/json', mockUrl('json')],
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
    const name = new URL(url).searchParams.get('recognition-mock')
    const source = name ? mockSources.get(name) : undefined
    if (source !== undefined) return { shortCircuit: true, format: 'module', source }
    return nextLoad(url, context)
  },
})

const routeUrl = new URL('./route.ts?recognition-subsidiary-scope-test', import.meta.url).href
const { POST } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function reset(allowedSubsidiaryIds: Set<string> | null): void {
  state.allowedSubsidiaryIds = allowedSubsidiaryIds
  state.projectsEnabled = true
  state.syncCalls.length = 0
  state.runCalls.length = 0
  state.runError = null
  state.syncSkipped = null
}

function post(): Promise<Response> {
  return POST(
    new Request('http://openbooks.test/api/revenue/run-recognition', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ asOfDate: '2026-08-31' }),
    }),
  )
}

test('mixed subsidiary scope synchronizes and posts only the permitted project set', async () => {
  reset(new Set(['subsidiary-visible']))

  const response = await post()

  assert.equal(response.status, 200)
  assert.deepEqual(state.syncCalls, [{
    scope: ['subsidiary-visible'],
    syncedProjectIds: ['project-visible'],
  }])
  assert.deepEqual(state.runCalls, [{
    scope: ['subsidiary-visible'],
    postedProjectIds: ['project-visible'],
  }])
})

test('a restricted scope containing only another subsidiary never reaches hidden project data', async () => {
  reset(new Set(['subsidiary-other']))

  const response = await post()

  assert.equal(response.status, 200)
  assert.deepEqual(state.syncCalls[0]?.syncedProjectIds, [])
  assert.deepEqual(state.runCalls[0]?.postedProjectIds, [])
})

test('an empty restricted scope fails closed before synchronization or posting', async () => {
  reset(new Set())

  const response = await post()

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    posted: 0,
    skipped: 0,
    totalAmount: '0',
    entries: [],
    problems: [],
  })
  assert.deepEqual(state.syncCalls, [])
  assert.deepEqual(state.runCalls, [])
})

test('a domain refusal from the run reaches the operator as a named 422, not a 500', async () => {
  reset(null)
  state.runError = { kind: 'domain', message: 'January 2026: GL period closed' }

  const response = await post()

  assert.equal(response.status, 422)
  assert.deepEqual(await response.json(), { error: 'January 2026: GL period closed' })
})

test('a stale confirmation stays a 409 naming the remedy', async () => {
  reset(null)
  state.runError = { kind: 'stale', message: 'the reviewed set changed' }

  const response = await post()

  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: 'stale_preview' })
})

test('a skipped project sync surfaces as a named warning on the run result', async () => {
  reset(null)
  state.syncSkipped = 'project revenue sync skipped: control accounts unmapped: unbilled receivable, project revenue — map them in Company & Accounting'

  const response = await post()

  assert.equal(response.status, 200)
  const body = (await response.json()) as { problems: string[] }
  assert.deepEqual(body.problems, [state.syncSkipped])
})

test('an unexpected run defect stays a generic 500', async () => {
  reset(null)
  state.runError = { kind: 'unexpected', message: 'connection terminated' }

  const response = await post()

  assert.equal(response.status, 500)
  assert.deepEqual(await response.json(), { error: 'Unable to run revenue recognition.' })
})

test('unrestricted access preserves organization-wide synchronization and posting', async () => {
  reset(null)

  const response = await post()

  assert.equal(response.status, 200)
  assert.deepEqual(state.syncCalls, [{
    scope: undefined,
    syncedProjectIds: ['project-visible', 'project-hidden'],
  }])
  assert.deepEqual(state.runCalls, [{
    scope: undefined,
    postedProjectIds: ['project-visible', 'project-hidden'],
  }])
})

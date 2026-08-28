import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

type Scope = string[] | undefined

interface RouteState {
  allowedSubsidiaryIds: Set<string> | null
  projectsEnabled: boolean
  syncCalls: { scope: Scope; syncedProjectIds: string[] }[]
  runCalls: { scope: Scope; postedProjectIds: string[] }[]
}

const stateKey = Symbol.for('openbooks.recognition-route-test')
const state: RouteState = {
  allowedSubsidiaryIds: null,
  projectsEnabled: true,
  syncCalls: [],
  runCalls: [],
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
        return { synced: [], problems: [] }
      }
    `,
  ],
  [
    'revenue-recognition',
    `
      const state = globalThis[Symbol.for('openbooks.recognition-route-test')]
      const projects = ${JSON.stringify(projects)}
      export async function runRevenueRecognition(_orgId, _asOfDate, _actorId, _obligationId, allowedSubsidiaryIds) {
        const visible = allowedSubsidiaryIds == null
          ? projects
          : projects.filter((project) => allowedSubsidiaryIds.includes(project.subsidiaryId))
        state.runCalls.push({ scope: allowedSubsidiaryIds == null ? undefined : [...allowedSubsidiaryIds], postedProjectIds: visible.map((project) => project.id) })
        return { posted: visible.length, skipped: 0, totalAmount: '0', entries: [], problems: [] }
      }
    `,
  ],
])

const selfUrl = new URL(import.meta.url).href
const mockUrl = (name: string) => `${selfUrl}?recognition-mock=${name}`
const mockUrls = new Map<string, string>([
  ['../../../../lib/authz', mockUrl('authz')],
  ['../../../../lib/features', mockUrl('features')],
  ['@openbooks/engine/src/business-date.ts', mockUrl('business-date')],
  ['@openbooks/engine/src/project-revenue.ts', mockUrl('project-revenue')],
  ['@openbooks/engine/src/revenue-recognition.ts', mockUrl('revenue-recognition')],
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

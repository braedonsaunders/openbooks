import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const stateKey = Symbol.for('openbooks.field-ticket-helper-scope-test')
const SUB_A = '00000000-0000-4000-8000-0000000000a1'
const SUB_B = '00000000-0000-4000-8000-0000000000b1'
const PROJECT_B = '00000000-0000-4000-8000-0000000000b2'
const ITEM_ID = '00000000-0000-4000-8000-0000000000c1'
const state = {
  queries: [] as string[],
  rateCalls: 0,
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

const module_ = (source: string) => ({
  shortCircuit: true as const,
  format: 'module' as const,
  url: `data:text/javascript,${encodeURIComponent(source)}`,
})

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return module_('export {}')
    if (specifier.endsWith('/lib/authz')) {
      const real = nextResolve(specifier, context).url
      return module_(`
        export * from ${JSON.stringify(real)};
        export async function guardPermission() {
          return {
            user: { orgId: '00000000-0000-4000-8000-000000000001', id: '00000000-0000-4000-8000-000000000002' },
            permissions: new Set(['time.read']),
            allowedSubsidiaryIds: new Set([${JSON.stringify(SUB_A)}]),
          };
        }
      `)
    }
    if (specifier === '@openbooks/engine/src/platform/db.ts') {
      const real = nextResolve(specifier, context).url
      return module_(`
        export * from ${JSON.stringify(real)};
        const state = globalThis[Symbol.for('openbooks.field-ticket-helper-scope-test')];
        export const db = {
          async execute(query) {
            const text = query?.queryChunks?.map((chunk) => Array.isArray(chunk?.value) ? chunk.value.join('') : '').join('') ?? '';
            state.queries.push(text);
            if (text.includes('from projects')) return { rows: [{ id: ${JSON.stringify(PROJECT_B)}, subsidiary_id: ${JSON.stringify(SUB_B)}, customer_name: 'B Customer' }] };
            return { rows: [{ id: 'task-b', code: 'B-1', name: 'B Task', status: 'active', estimatedHours: '8', default_rate: '125.00', default_cost: null, unit: 'hour', kind: 'service' }] };
          },
        };
      `)
    }
    if (specifier.endsWith('/lib/features')) return module_('export async function isFeatureEnabled() { return true }')
    if (specifier.endsWith('/lib/field-tickets')) return module_('export async function resolveTicketPeriod() { return { id: "period-b" } }')
    if (specifier.endsWith('/lib/item-rates')) return module_(`
      const state = globalThis[Symbol.for('openbooks.field-ticket-helper-scope-test')];
      export async function resolveItemRate() { state.rateCalls++; return null }
    `)
    return nextResolve(specifier, context)
  },
})

const { GET: projectContext } = await import('./route.ts')
const { GET: itemRate } = await import('../item-rate/route.ts')
hooks.deregister()

test('project context hides another subsidiary before loading customer and task details', async () => {
  state.queries.length = 0
  const response = await projectContext(new Request(`http://localhost/api/field-tickets/project-context?projectId=${PROJECT_B}`))
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: 'not found' })
  assert.equal(state.queries.length, 1, 'the task detail query never runs for the hidden project')
})

test('item-rate preview hides another subsidiary before resolving its price components', async () => {
  state.queries.length = 0
  state.rateCalls = 0
  const query = new URLSearchParams({ projectId: PROJECT_B, itemId: ITEM_ID, quantity: '1', onDate: '2026-09-24' })
  const response = await itemRate(new Request(`http://localhost/api/field-tickets/item-rate?${query}`))
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: 'not found' })
  assert.equal(state.queries.length, 1, 'the shared item price and rate-book reads never run for the hidden project')
  assert.equal(state.rateCalls, 0)
})

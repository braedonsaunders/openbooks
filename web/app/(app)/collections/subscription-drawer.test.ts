import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// The drawer opens by id, so it applies the subscriptions list's customer fence.

interface CapturedQuery {
  text: string
  values: unknown[]
}

const stateKey = Symbol.for('openbooks.subscription-drawer-test')
const state: {
  queries: CapturedQuery[]
  subscriptionRow: Record<string, unknown> | null
  authz: { user: { orgId: string }; permissions: Set<string>; allowedSubsidiaryIds: Set<string> | null }
} = {
  queries: [],
  subscriptionRow: null,
  authz: { user: { orgId: 'org-1' }, permissions: new Set(), allowedSubsidiaryIds: null },
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

const sources = new Map<string, string>([
  [
    'mock:drizzle',
    `
      function isFragment(value) {
        return value && typeof value === 'object' && typeof value.text === 'string' && Array.isArray(value.values)
      }
      function append(target, value) {
        if (isFragment(value)) {
          target.text += value.text
          target.values.push(...value.values)
        } else {
          target.text += '?'
          target.values.push(value)
        }
      }
      export function sql(strings, ...values) {
        const fragment = { text: '', values: [] }
        for (let index = 0; index < strings.length; index++) {
          fragment.text += strings[index]
          if (index < values.length) append(fragment, values[index])
        }
        return fragment
      }
      sql.join = function join(fragments, separator) {
        const joined = { text: '', values: [] }
        fragments.forEach((fragment, index) => {
          if (index > 0) append(joined, separator)
          append(joined, fragment)
        })
        return joined
      }
    `,
  ],
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.subscription-drawer-test')]
      export const db = {
        async execute(query) {
          state.queries.push({ text: query.text, values: [...query.values] })
          if (query.text.includes('from subscriptions s')) return { rows: state.subscriptionRow ? [state.subscriptionRow] : [] }
          return { rows: [] }
        },
      }
      export async function withOrgTransaction(_orgId, fn) { return fn(db) }
    `,
  ],
  [
    'mock:authz',
    `
      const state = globalThis[Symbol.for('openbooks.subscription-drawer-test')]
      export function can(authz, permission) {
        return authz.permissions.has('*') || authz.permissions.has(permission)
      }
      export async function requirePermission() { return state.authz }
    `,
  ],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const mock = new Map([
      ['drizzle-orm', 'mock:drizzle'],
      ['@openbooks/engine/platform/database', 'mock:db'],
      ['../../../lib/authz', 'mock:authz'],
    ]).get(specifier)
    if (mock) return { url: mock, shortCircuit: true }
    // The fence itself is the real shared helper, never a copy.
    if (specifier === '../../../lib/subsidiaries') {
      return nextResolve('@openbooks/engine/src/organization/subsidiary-scope.ts', context)
    }
    const resolved = nextResolve(specifier, context)
    if (resolved.url.endsWith('/engine/src/platform/db.ts')) return { url: 'mock:db', shortCircuit: true }
    return resolved
  },
  load(url, context, nextLoad) {
    const source = sources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const { loadSubscriptionDrawer } = await import('./subscription-drawer.ts')
hooks.deregister()

const SUBSCRIPTION_ID = '00000000-0000-0000-0000-0000000000aa'
const ALLOWED = '00000000-0000-0000-0000-000000000001'

function reset(allowed: Set<string> | null, permissions: string[], row: Record<string, unknown> | null = null) {
  state.queries.length = 0
  state.subscriptionRow = row
  state.authz = { user: { orgId: 'org-1' }, permissions: new Set(permissions), allowedSubsidiaryIds: allowed }
}

function subscriptionQuery(): CapturedQuery {
  const query = state.queries.find((candidate) => candidate.text.includes('from subscriptions s'))
  assert.ok(query, 'the drawer must read the subscription')
  return query
}

test('a restricted reader opens a subscription only inside its customer fence', async () => {
  reset(new Set([ALLOWED]), ['ar.read'])
  const result = await loadSubscriptionDrawer({ subscription: SUBSCRIPTION_ID })
  assert.equal(result.drawer, null)
  const query = subscriptionQuery()
  assert.match(query.text, /c\.subsidiary_id is null or c\.subsidiary_id = any/, 'unassigned customers stay org-wide')
  assert.ok(query.values.includes(`{${ALLOWED}}`))
})

test('a reader with no subsidiaries opens no subscription', async () => {
  reset(new Set(), ['ar.read'])
  await loadSubscriptionDrawer({ subscription: SUBSCRIPTION_ID })
  assert.match(subscriptionQuery().text, /and false/)
})

test('an unrestricted reader is not fenced', async () => {
  reset(null, ['ar.read'])
  await loadSubscriptionDrawer({ subscription: SUBSCRIPTION_ID })
  assert.doesNotMatch(subscriptionQuery().text, /subsidiary_id/)
})

test('the customer picker lists only customers inside the reader\'s fence', async () => {
  reset(new Set([ALLOWED]), ['ar.read', 'ar.create'], {
    id: SUBSCRIPTION_ID,
    status: 'active',
    customerId: 'customer-1',
    customerName: 'Customer',
  })
  await loadSubscriptionDrawer({ subscription: SUBSCRIPTION_ID })
  const picker = state.queries.find((query) => query.text.includes('from parties p'))
  assert.ok(picker, 'a manager gets the customer picker')
  assert.match(picker.text, /p\.subsidiary_id is null or p\.subsidiary_id = any/)
})

import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const stateKey = Symbol.for('openbooks.setup-wizard-route-test')

interface QueryRecord {
  text: string
  values: unknown[]
}

interface RouteState {
  queries: QueryRecord[]
  allowedSubsidiaryIds: Set<string> | null
}

const routeState: RouteState = { queries: [], allowedSubsidiaryIds: null }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState

const mockAuthz = `
  export async function guardPermission() {
    return {
      user: {
        orgId: '00000000-0000-4000-8000-000000000001',
        id: '00000000-0000-4000-8000-000000000002',
      },
      allowedSubsidiaryIds: globalThis[Symbol.for('openbooks.setup-wizard-route-test')].allowedSubsidiaryIds,
    }
  }
`

const mockDb = `
  const state = globalThis[Symbol.for('openbooks.setup-wizard-route-test')]

  function sqlText(query) {
    const chunks = query && query.queryChunks
    if (!Array.isArray(chunks)) return ''
    return chunks.map((chunk) => {
      if (typeof chunk === 'string') return chunk
      if (Array.isArray(chunk?.value)) return chunk.value.join('')
      if (Array.isArray(chunk?.queryChunks)) return sqlText(chunk)
      return ''
    }).join('')
  }

  function sqlValues(query) {
    const chunks = query && query.queryChunks
    if (!Array.isArray(chunks)) return []
    return chunks.flatMap((chunk) => {
      if (chunk && Array.isArray(chunk.queryChunks)) return sqlValues(chunk)
      if (chunk && Array.isArray(chunk.value)) return []
      return [chunk]
    })
  }

  async function execute(query) {
    const text = sqlText(query)
    state.queries.push({ text, values: sqlValues(query) })
    if (text.includes('from currencies')) return { rows: [{ one: 1 }] }
    if (text.includes('from journal_lines where org_id') && text.includes('select exists')) {
      return { rows: [{ posted: false }] }
    }
    if (text.includes('from orgs where id') && text.includes('for update')) {
      return {
        rows: [{
          name: 'Original Name',
          legal_name: 'Original Legal',
          base_currency: 'CAD',
          country: 'CA',
          settings: { industry: 'general_business' },
        }],
      }
    }
    if (text.includes('from subsidiaries s')) {
      return {
        rows: [{
          id: '00000000-0000-4000-8000-000000000003',
          name: 'Original Name',
          legal_name: 'Original Legal',
          base_currency: 'CAD',
          country: 'CA',
          entity_count: 1,
        }],
      }
    }
    return { rows: [] }
  }

  export const db = {
    execute,
    transaction: async (work) => work({ execute }),
  }
`

let authzRealUrl = ''
let dbRealUrl = ''
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (specifier === '../../../../../lib/authz' && context.parentURL?.includes('setup/wizard/route')) {
      authzRealUrl = nextResolve(specifier, context).url
      return { url: 'mock:setup-wizard-authz', shortCircuit: true }
    }
    if (specifier === '@openbooks/engine/src/platform/db.ts') {
      dbRealUrl = nextResolve(specifier, context).url
      return { url: 'mock:setup-wizard-db', shortCircuit: true }
    }
    if (specifier.startsWith('@/') && context.parentURL) {
      return nextResolve(new URL(`../../../../../${specifier.slice(2)}.ts`, context.parentURL).href, context)
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:setup-wizard-authz') {
      return { format: 'module', source: `export { guardUnrestrictedScope } from ${JSON.stringify(authzRealUrl)};\n${mockAuthz}`, shortCircuit: true }
    }
    if (url === 'mock:setup-wizard-db') {
      return { format: 'module', source: `export * from ${JSON.stringify(dbRealUrl)};\n${mockDb}`, shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?setup-wizard-route-test'
const { PUT, POST } = (await import(routeUrl)) as typeof import('./route.ts')
test.after(() => hooks.deregister())

const baseBody = {
  country: 'CA',
  fiscalYearStartMonth: 1,
  industry: 'general_business',
  features: {},
  workspaceProfile: {
    teamSize: 'solo',
    complexity: 'essentials',
    bookStart: 'fresh',
    taxPosition: 'not_registered',
    monthlyActivity: 'light',
    closeCadence: 'monthly',
  },
}

function reset(): void {
  routeState.queries = []
  routeState.allowedSubsidiaryIds = null
}

function rootUpdate(): QueryRecord {
  const query = routeState.queries.find(({ text }) => text.includes('update subsidiaries'))
  assert.ok(query, 'the single-root synchronization update should execute')
  return query
}

test('name-only reconfiguration preserves omitted legal name and root currency', async () => {
  reset()
  const response = await PUT(new Request('http://openbooks.test/api/admin/setup/wizard', {
    method: 'PUT',
    body: JSON.stringify({ ...baseBody, name: 'Renamed Company' }),
  }))

  assert.equal(response.status, 200)
  const update = rootUpdate()
  assert.equal(update.values.includes(undefined), false, 'omitted fields must never bind as SQL NULL')
  assert.equal(update.values.includes('CAD'), true, 'the existing root currency must be retained')
  assert.equal(update.values.includes('Original Legal'), true, 'the existing root legal name must be retained')
})

test('explicit currency reconfiguration updates the root currency', async () => {
  reset()
  const response = await PUT(new Request('http://openbooks.test/api/admin/setup/wizard', {
    method: 'PUT',
    body: JSON.stringify({ ...baseBody, name: 'Renamed Company', baseCurrency: 'USD' }),
  }))

  assert.equal(response.status, 200)
  const update = rootUpdate()
  assert.equal(update.values.includes('USD'), true, 'an explicit currency change must reach the root update')
})

test('the wizard takes the feature-gate fence before any gate reads or row locks', async () => {
  reset()
  const response = await PUT(new Request('http://openbooks.test/api/admin/setup/wizard', {
    method: 'PUT',
    body: JSON.stringify({ ...baseBody, name: 'Renamed Company' }),
  }))

  assert.equal(response.status, 200)
  const fenceIndex = routeState.queries.findIndex(
    ({ text, values }) =>
      text.includes('pg_advisory_xact_lock') && values.some((v) => typeof v === 'string' && v.startsWith('openbooks:feature-gate:')),
  )
  assert.ok(fenceIndex > -1, 'the wizard must take the feature-gate fence inside its transaction')
  const orgLockIndex = routeState.queries.findIndex(({ text }) => text.includes('from orgs where id') && text.includes('for update'))
  assert.ok(orgLockIndex > fenceIndex, 'the fence must precede the org row lock, like the Features switchboard')
})

test('restricted actors cannot mutate setup wizard org settings', async () => {
  reset()
  routeState.allowedSubsidiaryIds = new Set(['subsidiary-a'])
  const putResponse = await PUT(new Request('http://openbooks.test/api/admin/setup/wizard', {
    method: 'PUT',
    body: JSON.stringify({ ...baseBody, name: 'Should Not Save' }),
  }))
  const postResponse = await POST()
  assert.equal(putResponse.status, 403)
  assert.equal(postResponse.status, 403)
  assert.deepEqual(await putResponse.json(), { error: 'requires unrestricted subsidiary access' })
  assert.deepEqual(await postResponse.json(), { error: 'requires unrestricted subsidiary access' })
  assert.deepEqual(routeState.queries, [], 'neither org settings write enters its transaction')
})

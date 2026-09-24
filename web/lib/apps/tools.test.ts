import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    return nextResolve(specifier, context)
  },
})
const { readOnlyAppHostAdapters } = await import('./tool-capabilities')
const { runAppTool } = await import('./tools')
hooks.deregister()

const inputSchema = { type: 'object', properties: {}, additionalProperties: false }
const appFor = (readOnly: boolean) => ({
  status: 'installed',
  grantedPermissions: [],
  manifest: {
    tools: [{ key: 'probe', handler: 'probe', inputSchema, readOnly, requiredPermissions: [] }],
  },
})

test('runAppTool carries the installed tool readOnly declaration into the invocation boundary', async () => {
  const invocations: { readOnlyTool?: boolean }[] = []
  const base = {
    orgId: 'org-1',
    user: {} as never,
    appKey: 'probe-app',
    toolKey: 'probe',
    input: {},
    userCan: () => true,
    allowedSubsidiaryIds: null,
    idempotencyKey: 'invocation-identity-1',
  }
  const invoke = async (options: { readOnlyTool?: boolean }) => {
    invocations.push(options)
    return { ok: true as const, result: { completed: true } }
  }

  const read = await runAppTool(base, { getApp: async () => appFor(true) as never, invoke: invoke as never })
  const write = await runAppTool(base, { getApp: async () => appFor(false) as never, invoke: invoke as never })

  assert.deepEqual(read, { ok: true, result: { completed: true } })
  assert.deepEqual(write, { ok: true, result: { completed: true } })
  assert.deepEqual(invocations.map(({ readOnlyTool }) => readOnlyTool), [true, false])
})

test('a read-only app invocation receives no storage, journal, or platform write adapters', async () => {
  let writes = 0
  const adapters = readOnlyAppHostAdapters({
    storage: {
      async get() { return null },
      async set() { writes++ },
      async list() { return [] },
      async delete() { writes++ },
    },
    journal: { async create() { writes++; return {} } },
    platform: {
      async schema() { return [] },
      async list() { return [] },
      async get() { return null },
      async create() { writes++; return {} },
      async update() { writes++; return {} },
      async delete() { writes++; return {} },
    },
  })

  assert.deepEqual(Object.keys(adapters.storage).sort(), ['get', 'list'])
  assert.deepEqual(Object.keys(adapters.platform ?? {}).sort(), ['get', 'list', 'schema'])
  assert.equal(adapters.journal, undefined)
  assert.equal(writes, 0)
  assert.equal(await adapters.storage.get('key', 'default'), null)
  assert.deepEqual(await adapters.platform?.list('records', {}), [])
})

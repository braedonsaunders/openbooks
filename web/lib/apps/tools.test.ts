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
const { runAppTool, runListedAppTool } = await import('./tools')
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
    readOnlyTool: true,
    userCan: () => true,
    allowedSubsidiaryIds: null,
    idempotencyKey: 'invocation-identity-1',
  }
  const invoke = async (options: { readOnlyTool?: boolean }) => {
    invocations.push(options)
    return { ok: true as const, result: { completed: true } }
  }

  const read = await runAppTool(base, { getApp: async () => appFor(true) as never, invoke: invoke as never })
  const write = await runAppTool({ ...base, readOnlyTool: false }, { getApp: async () => appFor(false) as never, invoke: invoke as never })

  assert.deepEqual(read, { ok: true, result: { completed: true } })
  assert.deepEqual(write, { ok: true, result: { completed: true } })
  assert.deepEqual(invocations.map(({ readOnlyTool }) => readOnlyTool), [true, false])
})

test('runAppTool refuses an MCP catalog declaration that no longer matches the stored app tool', async () => {
  let invoked = false
  const result = await runAppTool({
    orgId: 'org-1',
    user: {} as never,
    appKey: 'probe-app',
    toolKey: 'probe',
    input: {},
    readOnlyTool: true,
    userCan: () => true,
    allowedSubsidiaryIds: null,
    idempotencyKey: 'invocation-identity-2',
  }, {
    getApp: async () => appFor(false) as never,
    invoke: (async () => { invoked = true; return { ok: true, result: {} } }) as never,
  })
  assert.deepEqual(result, { ok: false, error: 'app tool permissions changed; refresh the tool catalog before invoking it', status: 409 })
  assert.equal(invoked, false)
})

test('the MCP catalog runner forwards the stored app write classification to the adapter boundary', async () => {
  let invocationReadOnly: boolean | undefined
  const result = await runListedAppTool({
    view: { appKey: 'probe-app', toolKey: 'probe', readOnly: false },
    orgId: 'org-1',
    user: {} as never,
    input: {},
    userCan: () => true,
    allowedSubsidiaryIds: null,
    idempotencyKey: 'mcp-write-identity',
  }, {
    getApp: async () => appFor(false) as never,
    invoke: (async ({ readOnlyTool }: { readOnlyTool?: boolean }) => {
      invocationReadOnly = readOnlyTool
      return { ok: true, result: {} }
    }) as never,
  })
  assert.deepEqual(result, { ok: true, result: {} })
  assert.equal(invocationReadOnly, false)
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

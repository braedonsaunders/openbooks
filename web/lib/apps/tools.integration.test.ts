// Run with (one file per process):
//   env $OB_TEST_ENV SESSION_SECRET=<64-hex> node --import tsx --import ./engine/src/testing/database-bypass.ts \
//     --test --test-force-exit web/lib/apps/tools.integration.test.ts
// End-to-end proof for App-declared assistant tools: a fixture app with a
// read tool and a mutating tool is installed, then both are driven through
// the assistant registry — visibility, execution, confirmation, commit,
// replay, and tenant/permission isolation.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (specifier.startsWith('@/')) {
      return nextResolve(new URL(`../../${specifier.slice(2)}`, import.meta.url).href, context)
    }
    return nextResolve(specifier, context)
  },
})

const { installApp } = await import('./store')
const { commitAppToolCommand } = await import('./tools')
const { buildToolRegistryAsync, executeAssistantTool } = await import('../assistant/registry')
const { createOpenBooksMcpServer } = await import('../mcp/server')
const { Client: McpClient } = await import('@modelcontextprotocol/sdk/client/index.js')
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  '@openbooks/engine/src/testing/fixtures.ts'
)
import type { Authz } from '../authz'

const DB = !!env.OPENBOOKS_DB_URL
const APP_KEY = `assistant-fixture-${randomUUID().slice(0, 8)}`
const snake = APP_KEY.replaceAll('-', '_')
const READ_TOOL = `app_${snake}_lookup`
const MUTATING_TOOL = `app_${snake}_bump`

type Fixture = {
  orgId: string
  otherOrgId: string
  adminId: string
  adminAuthz: Authz
  limitedAuthz: Authz
  noWriteAuthz: Authz
  otherOrgAuthz: Authz
}

function authzFor(
  user: { id: string; orgId: string; email: string; name: string },
  permissions: Set<string>,
): Authz {
  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      roles: [{ key: 'admin', name: 'Admin' }],
      orgId: user.orgId,
      envKind: 'production',
      productionOrgId: user.orgId,
      isSuperAdmin: false,
      homeUserId: user.id,
      homeOrgId: user.orgId,
    },
    permissions,
    allowedSubsidiaryIds: null,
  } as unknown as Authz
}

async function makeFixture(lookupHandler?: string): Promise<Fixture> {
  return await withBypass(async () => {
    const org = await createScratchOrg()
    const other = await createScratchOrg()
    const { adminId } = await seedFlowActors(org.orgId)
    const base = { id: adminId, orgId: org.orgId, email: 'asst-tools@scratch.test', name: 'Tool Caller' }
    await installApp(org.orgId, adminId, {
      manifest: {
        key: APP_KEY,
        name: 'Assistant Fixture',
        version: '1.0.0',
        permissions: ['records.read'],
        frontend: { entry: 'frontend/index.html' },
        endpoints: [
          { name: 'lookup', file: 'backend/lookup.js' },
          { name: 'counter', file: 'backend/counter.js', method: 'POST' },
        ],
        tools: [
          {
            key: 'lookup',
            title: 'Look up',
            description: 'Echoes the query.',
            inputSchema: {
              type: 'object',
              properties: { q: { type: 'string', description: 'Query', maxLength: 200 } },
              required: ['q'],
            },
            handler: 'lookup',
            requiredPermissions: ['records.read'],
          },
          {
            key: 'bump',
            title: 'Bump',
            description: 'Increments the fixture counter.',
            inputSchema: {
              type: 'object',
              properties: { label: { type: 'string', description: 'Label', maxLength: 40 } },
            },
            handler: 'counter',
            readOnly: false,
            confirmation: 'always',
          },
        ],
      },
      files: [
        { path: 'frontend/index.html', content: '<html><body>fixture</body></html>' },
        {
          path: 'backend/lookup.js',
          content: lookupHandler ?? 'function handler(req) { var q = req.body && req.body.q; return { status: 200, body: { echo: q } } }',
        },
        {
          path: 'backend/counter.js',
          content: 'function handler(req) { var cur = ob.storage.get("bumps", "tools") || 0; ob.storage.set("bumps", cur + 1, "tools"); return { status: 200, body: { bumps: cur + 1 } } }',
        },
      ],
    })
    return {
      orgId: org.orgId,
      otherOrgId: other.orgId,
      adminId,
      adminAuthz: authzFor(base, new Set(['*'])),
      limitedAuthz: authzFor(base, new Set(['assistant.use', 'assistant.write', 'apps.use'])),
      noWriteAuthz: authzFor(base, new Set(['assistant.use', 'apps.use'])),
      otherOrgAuthz: authzFor(
        { id: adminId, orgId: other.orgId, email: 'other@scratch.test', name: 'Other Org' },
        new Set(['*']),
      ),
    }
  })
}

/**
 * One fixture per test. The pooled integration runner drains scratch-org
 * leases at every test boundary, so a fixture memoized across top-level tests
 * silently disappears under CI; each test creates, uses, and releases its own.
 */
async function withFixture(run: (fx: Fixture) => Promise<void>, lookupHandler?: string): Promise<void> {
  const fx = await makeFixture(lookupHandler)
  try {
    // Assistant tool subjects resolve their app and registry from the
    // ambient tenant scope, exactly as a production request would carry it.
    await withOrgContext(fx.orgId, () => run(fx))
  } finally {
    await withBypass(() => dropScratchOrg(fx.orgId))
    await withBypass(() => dropScratchOrg(fx.otherOrgId))
  }
}

test('read tool executes through executeAssistantTool with the stored schema', { skip: !DB }, async () => withFixture(async (fx) => {
  const result = await executeAssistantTool(fx.adminAuthz, READ_TOOL, { q: 'hello' })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual((result as { ok: true; data: unknown }).data, { status: 200, body: { echo: 'hello' } })
}))

test('repeating an identical read runs again instead of replaying stale app data', { skip: !DB }, async () => withFixture(async (fx) => {
  const first = await executeAssistantTool(fx.adminAuthz, READ_TOOL, { q: 'same query' })
  const second = await executeAssistantTool(fx.adminAuthz, READ_TOOL, { q: 'same query' })
  assert.equal(first.ok, true)
  assert.deepEqual(second, first)

  const claims = await withOrgContext(fx.orgId, () => db.execute<{ n: string }>(sql`
    select count(*)::text as n from application_idempotency_keys
     where org_id = ${fx.orgId} and source = 'app'
       and operation = ${`apps.assistant_tool.${READ_TOOL}`}
  `))
  assert.equal(Number(claims.rows[0]!.n), 2, 'each chat read has its own invocation identity')
}))

test('oversized app tool responses are refused before they reach the model', { skip: !DB }, async () => withFixture(async (fx) => {
  const result = await executeAssistantTool(fx.adminAuthz, READ_TOOL, { q: 'large' })
  assert.deepEqual(result, { ok: false, error: 'tool response too large; narrow the request' })
}, 'function handler() { return { status: 200, body: { payload: "x".repeat(70 * 1024) } } }'))

test('installation refuses a tool outside the admin grant before creating the app', { skip: !DB }, async () => withFixture(async (fx) => {
  const key = `${APP_KEY}-denied`
  await assert.rejects(
    withBypass(() => installApp(fx.orgId, fx.adminId, {
      manifest: {
        key,
        name: 'Denied Tool Fixture',
        version: '1.0.0',
        permissions: ['records.read'],
        frontend: { entry: 'frontend/index.html' },
        endpoints: [{ name: 'lookup', file: 'backend/lookup.js' }],
        tools: [{
          key: 'lookup',
          title: 'Look up',
          description: 'Echoes the query.',
          inputSchema: {
            type: 'object',
            properties: { q: { type: 'string', description: 'Query', maxLength: 200 } },
            required: ['q'],
          },
          handler: 'lookup',
          requiredPermissions: ['records.read'],
        }],
      },
      grantedPermissions: [],
      files: [
        { path: 'frontend/index.html', content: '<html></html>' },
        { path: 'backend/lookup.js', content: 'function handler() { return { status: 200, body: {} } }' },
      ],
    })),
    /invalid app tools:.*records\.read.*not granted/,
  )
  const rows = await withBypass(() => db.execute<{ count: string }>(sql`
    select count(*)::text as count from apps where org_id = ${fx.orgId} and key = ${key}
  `))
  assert.equal(rows.rows[0]!.count, '0')
}))

test('registry exposes installed tools only to actors holding the grant intersection', { skip: !DB }, async () => withFixture(async (fx) => {
  const adminTools = await buildToolRegistryAsync(fx.adminAuthz)
  assert.ok(READ_TOOL in adminTools, 'admin sees the read tool')
  assert.ok(MUTATING_TOOL in adminTools, 'admin sees the mutating tool')
  const limitedTools = await buildToolRegistryAsync(fx.limitedAuthz)
  assert.ok(!(READ_TOOL in limitedTools), 'records.read-gated tool is hidden without the permission')
  assert.ok(MUTATING_TOOL in limitedTools, 'grant-free tool stays visible')
  const otherTools = await withOrgContext(fx.otherOrgId, () => buildToolRegistryAsync(fx.otherOrgAuthz))
  assert.ok(!(READ_TOOL in otherTools) && !(MUTATING_TOOL in otherTools), 'another org sees nothing')
}))

test('MCP catalog enforces both app grants and the assistant doorway', { skip: !DB }, async () => withFixture(async (fx) => {
  async function listFor(authz: Authz): Promise<string[]> {
    const requestId = randomUUID()
    const server = await withOrgContext(authz.user.orgId, () => createOpenBooksMcpServer({
      auth: {
        user: authz.user,
        keyId: randomUUID(),
        permissions: authz.permissions,
        rateLimitPerMin: null,
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
        audit: {
          method: 'MCP', path: '/mcp', ipAddress: null, userAgent: null, startedAt: Date.now(),
        },
      },
      request: new Request('http://localhost/mcp'),
      requestId,
    }))
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new McpClient({ name: 'OpenBooks test client', version: '1.0.0' })
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
      const result = await client.listTools()
      return result.tools.map(({ name }) => name)
    } finally {
      await Promise.all([client.close(), server.close()])
    }
  }

  const adminNames = await listFor(fx.adminAuthz)
  const limitedNames = await listFor(fx.limitedAuthz)
  const noAssistantAuthz = {
    ...fx.adminAuthz,
    permissions: new Set(['apps.use', 'records.read']),
  }
  const noAssistantNames = await listFor(noAssistantAuthz)
  assert.ok(adminNames.includes(READ_TOOL), 'granted app tool appears in the MCP catalog')
  assert.ok(!limitedNames.includes(READ_TOOL), 'tool requiring records.read is absent without that grant')
  assert.ok(!noAssistantNames.includes(READ_TOOL), 'apps.use and the app grant do not bypass assistant.use')
}))

test('permission refusals and bad input fail closed without executing', { skip: !DB }, async () => withFixture(async (fx) => {
  assert.deepEqual(
    await executeAssistantTool(fx.limitedAuthz, READ_TOOL, { q: 'x' }),
    { ok: false, error: 'forbidden' },
  )
  const invalid = await executeAssistantTool(fx.adminAuthz, READ_TOOL, {})
  assert.equal(invalid.ok, false)
  assert.match((invalid as { ok: false; error: string }).error, /invalid_input/)
  assert.deepEqual(
    await executeAssistantTool(fx.adminAuthz, 'app_no_such_app_no_tool', {}),
    { ok: false, error: 'forbidden' },
  )
}))

test('mutating tool proposes, commits, and replays the same outcome', { skip: !DB }, async () => withFixture(async (fx) => {
  const proposed = await executeAssistantTool(fx.adminAuthz, MUTATING_TOOL, { label: 'c7' })
  assert.equal(proposed.ok, true, JSON.stringify(proposed))
  const card = (proposed as { ok: true; data: { proposedApplicationCommand: { toolName: string; input: unknown; confirmToken: string } } }).data.proposedApplicationCommand
  assert.equal(card.toolName, MUTATING_TOOL)
  assert.ok(typeof card.confirmToken === 'string' && card.confirmToken.length > 0)

  const first = await commitAppToolCommand(fx.adminAuthz, MUTATING_TOOL, card.input, card.confirmToken)
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.deepEqual((first as { ok: true; result: unknown }).result, { status: 200, body: { bumps: 1 } })

  // A retried Apply replays the stored outcome instead of bumping again.
  const replay = await commitAppToolCommand(fx.adminAuthz, MUTATING_TOOL, card.input, card.confirmToken)
  assert.deepEqual(replay, first)

  // Tampering with the confirmed input voids the token.
  assert.deepEqual(
    await commitAppToolCommand(fx.adminAuthz, MUTATING_TOOL, { label: 'changed' }, card.confirmToken),
    { ok: false, error: 'confirmation_expired_or_modified', status: 422 },
  )
}))

test('proposing and committing require the write permission', { skip: !DB }, async () => withFixture(async (fx) => {
  assert.deepEqual(
    await executeAssistantTool(fx.noWriteAuthz, MUTATING_TOOL, {}),
    { ok: false, error: 'forbidden' },
  )
  assert.deepEqual(
    await commitAppToolCommand(fx.noWriteAuthz, MUTATING_TOOL, {}, 'bogus-token'),
    { ok: false, error: 'forbidden', status: 403 },
  )
}))

test('tool invocations leave app_runs evidence', { skip: !DB }, async () => withFixture(async (fx) => {
  const orgId = fx.orgId
  for (const q of ['one', 'two', 'three']) {
    const result = await executeAssistantTool(fx.adminAuthz, READ_TOOL, { q })
    assert.equal(result.ok, true, JSON.stringify(result))
  }
  const rows = await withOrgContext(orgId, () =>
    db.execute<{ n: string }>(sql`select count(*) as n from app_runs where org_id = ${orgId}`),
  )
  assert.ok(Number(rows.rows[0]!.n) >= 3, `expected tool invocation evidence, got ${rows.rows[0]!.n}`)
}))

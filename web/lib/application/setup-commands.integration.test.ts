import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { sql } from 'drizzle-orm'
import { BUILT_IN_ROLES } from '@openbooks/engine/src/organization/permissions.ts'
import { db, env, withBypassContext, withOrgContext } from '@openbooks/engine/src/platform/db.ts'
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  type ScratchOrg,
} from '@openbooks/engine/src/testing/fixtures.ts'
import type { ApplicationContext } from './context'
import type { Authz } from '../authz'
import type { SessionUser } from '../auth'

// Same seam as web/lib/setup-feature-fence.integration.test.ts: shim the
// RSC `server-only` marker and forward Next's `@/*` alias to `web/*` from
// the repo root (this file runs from the root, one file per process).
const root = pathToFileURL(process.cwd() + '/').href
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (specifier.startsWith('@/')) {
      return nextResolve(root + 'web/' + specifier.slice(2) + '.ts', context)
    }
    return nextResolve(specifier, context)
  },
})
const { applicationTool, executeApplicationTool } = await import('./tool-catalog.ts')
const { applicationContextFromSession } = await import('./context.ts')

const DB = !!env.OPENBOOKS_DB_URL
const ADMIN_PERMISSIONS = ['admin.setup.manage', 'admin.users.manage']
const VIEWER_PERMISSIONS = [...(BUILT_IN_ROLES.viewer?.permissions ?? ['gl.read'])]

function sessionUser(orgId: string, id: string, name: string, roleKey: string, roleName: string): SessionUser {
  return {
    id,
    email: `${id.slice(0, 8)}@scratch.test`,
    name,
    roles: [{ key: roleKey, name: roleName }],
    orgId,
    envKind: 'production',
    productionOrgId: orgId,
    isSuperAdmin: false,
    homeUserId: id,
    homeOrgId: orgId,
  }
}

function contextFor(org: ScratchOrg, userId: string, name: string, roleKey: string, roleName: string, permissions: string[]): ApplicationContext {
  const authz: Authz = {
    user: sessionUser(org.orgId, userId, name, roleKey, roleName),
    permissions: new Set(permissions),
    allowedSubsidiaryIds: null,
  }
  return applicationContextFromSession(authz, 'assistant', randomUUID())
}

async function adminContext(org: ScratchOrg): Promise<ApplicationContext> {
  const { adminId } = await withBypassContext(() => seedFlowActors(org.orgId))
  return contextFor(org, adminId, 'Setup Admin', 'admin', 'Admin', ADMIN_PERMISSIONS)
}

async function viewerContext(org: ScratchOrg): Promise<ApplicationContext> {
  const { outsiderId } = await withBypassContext(() => seedFlowActors(org.orgId))
  return contextFor(org, outsiderId, 'Viewer', 'viewer', 'Viewer', VIEWER_PERMISSIONS)
}

// Production serves every tool call inside the caller's request org scope.
// Run each call the same way so gates (not the RLS backstop) produce the
// asserted ok/refusal, and cross-org refusals come from the tool's own
// org check under the session org.
async function callTool(
  org: ScratchOrg,
  definition: Parameters<typeof executeApplicationTool>[0],
  context: ApplicationContext,
  rawInput: unknown,
): Promise<Record<string, unknown>> {
  return withOrgContext(org.orgId, () => executeApplicationTool(definition, context, rawInput))
}

async function orgName(orgId: string): Promise<string> {
  const row = (await withOrgContext(orgId, () => db.execute<{ name: string }>(sql`select name from orgs where id = ${orgId}`))).rows[0]
  return row!.name
}

async function orgLegalName(orgId: string): Promise<string | null> {
  const row = (await withOrgContext(orgId, () => db.execute<{ legal_name: string | null }>(sql`select legal_name from orgs where id = ${orgId}`))).rows[0]
  return row!.legal_name
}

test('get_company_settings reads the caller org through the shared settings command', { skip: !DB }, async () => {
  const orgA = await createScratchOrg()
  const orgB = await createScratchOrg()
  try {
    const tool = applicationTool('get_company_settings')
    assert.ok(tool, 'get_company_settings must resolve in the application catalog')
    const adminA = await adminContext(orgA)
    const adminB = await adminContext(orgB)
    const view = await callTool(orgA, tool, adminA, {})
    assert.equal(view.ok, true)
    assert.equal((view as { org: { name: string } }).org.name, await orgName(orgA.orgId))
    assert.equal((view as { accounting: { baseCurrency: string } }).accounting.baseCurrency.length, 3)
    assert.equal(typeof (view as { features: Record<string, boolean> }).features, 'object')
    assert.equal(view.href, '/admin/settings')
    // Cross-org isolation: the same tool under org B's actor returns org B, never org A.
    const foreign = await callTool(orgB, tool, adminB, {})
    assert.equal((foreign as { org: { name: string } }).org.name, await orgName(orgB.orgId))
    assert.notEqual((foreign as { org: { name: string } }).org.name, (view as { org: { name: string } }).org.name)
    // Permission refusal: a viewer outside both admin gates never reaches the command.
    await assert.rejects(callTool(orgA, tool, await viewerContext(orgA), {}), /forbidden/)
  } finally {
    await dropScratchOrg(orgA.orgId)
    await dropScratchOrg(orgB.orgId)
  }
})

test('update_company_settings mutates only the caller org and replays idempotently', { skip: !DB }, async () => {
  const orgA = await createScratchOrg()
  const orgB = await createScratchOrg()
  try {
    const tool = applicationTool('update_company_settings')
    assert.ok(tool, 'update_company_settings must resolve in the application catalog')
    const adminA = await adminContext(orgA)
    const key = randomUUID()
    const first = await callTool(orgA, tool, adminA, { changes: { legalName: 'A01 Test Holdings Ltd' }, idempotencyKey: key })
    assert.equal(first.ok, true)
    assert.equal(first.replayed, false)
    assert.equal(await orgLegalName(orgA.orgId), 'A01 Test Holdings Ltd')
    // Idempotent replay: the same key returns the stored outcome without a second mutation.
    const replay = await callTool(orgA, tool, adminA, { changes: { legalName: 'A01 Test Holdings Ltd' }, idempotencyKey: key })
    assert.equal(replay.ok, true)
    assert.equal(replay.replayed, true)
    assert.equal(await orgLegalName(orgA.orgId), 'A01 Test Holdings Ltd')
    // Permission refusal: a non-admin changes nothing.
    await assert.rejects(
      callTool(orgA, tool, await viewerContext(orgA), { changes: { legalName: 'Nope' }, idempotencyKey: randomUUID() }),
      /forbidden/,
    )
    assert.equal(await orgLegalName(orgA.orgId), 'A01 Test Holdings Ltd')
    // Cross-org isolation: org B's actor cannot move org A's settings, and its own write stays home.
    const adminB = await adminContext(orgB)
    await callTool(orgB, tool, adminB, { changes: { legalName: 'Org B Legal' }, idempotencyKey: randomUUID() })
    assert.equal(await orgLegalName(orgB.orgId), 'Org B Legal')
    assert.equal(await orgLegalName(orgA.orgId), 'A01 Test Holdings Ltd')
  } finally {
    await dropScratchOrg(orgA.orgId)
    await dropScratchOrg(orgB.orgId)
  }
})

test('update_features toggles through the fenced command and replays idempotently', { skip: !DB }, async () => {
  const orgA = await createScratchOrg()
  const orgB = await createScratchOrg()
  try {
    const tool = applicationTool('update_features')
    assert.ok(tool, 'update_features must resolve in the application catalog')
    const adminA = await adminContext(orgA)
    const key = randomUUID()
    const first = await callTool(orgA, tool, adminA, { features: { onlinePayments: true }, idempotencyKey: key })
    assert.equal(first.ok, true)
    assert.equal(first.replayed, false)
    assert.equal((first as { after: Record<string, boolean> }).after.onlinePayments, true)
    const replay = await callTool(orgA, tool, adminA, { features: { onlinePayments: true }, idempotencyKey: key })
    assert.equal(replay.ok, true)
    assert.equal(replay.replayed, true)
    assert.deepEqual(
      (replay as { after: Record<string, boolean> }).after,
      (first as { after: Record<string, boolean> }).after,
    )
    // Unknown keys are refused as invalid input, never stored.
    await assert.rejects(
      callTool(orgA, tool, adminA, { features: { not_a_module: true }, idempotencyKey: randomUUID() }),
      /invalid-feature/,
    )
    // Permission refusal: a non-admin cannot toggle.
    await assert.rejects(
      callTool(orgA, tool, await viewerContext(orgA), { features: { onlinePayments: false }, idempotencyKey: randomUUID() }),
      /forbidden/,
    )
    // Cross-org isolation: toggling under org B leaves org A enabled.
    const adminB = await adminContext(orgB)
    await callTool(orgB, tool, adminB, { features: { onlinePayments: true }, idempotencyKey: randomUUID() })
    const flagsA = (await withOrgContext(orgA.orgId, () => db.execute<{ features: Record<string, boolean> }>(sql`
      select coalesce(settings->'features', '{}'::jsonb) as features from orgs where id = ${orgA.orgId}`))).rows[0]!.features
    assert.equal(flagsA.onlinePayments, true)
  } finally {
    await dropScratchOrg(orgA.orgId)
    await dropScratchOrg(orgB.orgId)
  }
})

test('create_setup_record creates through the shared validated command and replays idempotently', { skip: !DB }, async () => {
  const orgA = await createScratchOrg()
  try {
    const tool = applicationTool('create_setup_record')
    assert.ok(tool, 'create_setup_record must resolve in the application catalog')
    const adminA = await adminContext(orgA)
    const body = { code: 'TOOL-VAT', name: 'Tool VAT', isActive: true }
    const key = randomUUID()
    const first = await callTool(orgA, tool, adminA, { entityKey: 'tax-codes', body, idempotencyKey: key })
    assert.equal(first.ok, true)
    assert.equal(first.replayed, false)
    const id = (first as { id: string }).id
    assert.ok(id, 'the created row id must be returned')
    const replay = await callTool(orgA, tool, adminA, { entityKey: 'tax-codes', body, idempotencyKey: key })
    assert.equal(replay.ok, true)
    assert.equal(replay.replayed, true)
    const rows = (await withOrgContext(orgA.orgId, () => db.execute<{ id: string }>(sql`
      select id from tax_codes where org_id = ${orgA.orgId} and code = 'TOOL-VAT'`))).rows
    assert.equal(rows.length, 1, 'the replay must not create a second row')
    assert.equal(rows[0]!.id, id)
    // Permission refusal: a non-admin creates nothing.
    await assert.rejects(
      callTool(orgA, tool, await viewerContext(orgA), {
        entityKey: 'tax-codes', body: { code: 'NOPE', name: 'Nope', isActive: true }, idempotencyKey: randomUUID(),
      }),
      /forbidden/,
    )
    assert.equal((await withOrgContext(orgA.orgId, () => db.execute(sql`select id from tax_codes where org_id = ${orgA.orgId} and code = 'NOPE'`))).rows.length, 0)
  } finally {
    await dropScratchOrg(orgA.orgId)
  }
})

test('update_setup_record edits only the caller org row and replays idempotently', { skip: !DB }, async () => {
  const orgA = await createScratchOrg()
  const orgB = await createScratchOrg()
  try {
    const tool = applicationTool('update_setup_record')
    assert.ok(tool, 'update_setup_record must resolve in the application catalog')
    const adminA = await adminContext(orgA)
    const adminB = await adminContext(orgB)
    const create = applicationTool('create_setup_record')
    assert.ok(create, 'create_setup_record must resolve in the application catalog')
    const created = (await callTool(orgA, create, adminA, {
      entityKey: 'tax-codes', body: { code: 'UPD-VAT', name: 'Before', isActive: true }, idempotencyKey: randomUUID(),
    })) as { id: string }
    const id = created.id
    // Cross-org isolation: org B's admin cannot see org A's row.
    await assert.rejects(
      callTool(orgB, tool, adminB, { entityKey: 'tax-codes', id, body: { name: 'Foreign' }, idempotencyKey: randomUUID() }),
      /not found/,
    )
    const key = randomUUID()
    const first = await callTool(orgA, tool, adminA, { entityKey: 'tax-codes', id, body: { name: 'After' }, idempotencyKey: key })
    assert.equal(first.ok, true)
    assert.equal(first.replayed, false)
    const replay = await callTool(orgA, tool, adminA, { entityKey: 'tax-codes', id, body: { name: 'After' }, idempotencyKey: key })
    assert.equal(replay.ok, true)
    assert.equal(replay.replayed, true)
    const name = (await withOrgContext(orgA.orgId, () => db.execute<{ name: string }>(sql`
      select name from tax_codes where id = ${id} and org_id = ${orgA.orgId}`))).rows[0]!.name
    assert.equal(name, 'After')
    // Permission refusal: a non-admin edits nothing.
    await assert.rejects(
      callTool(orgA, tool, await viewerContext(orgA), { entityKey: 'tax-codes', id, body: { name: 'Nope' }, idempotencyKey: randomUUID() }),
      /forbidden/,
    )
    const still = (await withOrgContext(orgA.orgId, () => db.execute<{ name: string }>(sql`
      select name from tax_codes where id = ${id} and org_id = ${orgA.orgId}`))).rows[0]!.name
    assert.equal(still, 'After')
  } finally {
    await dropScratchOrg(orgA.orgId)
    await dropScratchOrg(orgB.orgId)
  }
})

test('delete_setup_record removes only the caller org row and replays idempotently', { skip: !DB }, async () => {
  const orgA = await createScratchOrg()
  const orgB = await createScratchOrg()
  try {
    const tool = applicationTool('delete_setup_record')
    const create = applicationTool('create_setup_record')
    assert.ok(tool, 'delete_setup_record must resolve in the application catalog')
    assert.ok(create, 'create_setup_record must resolve in the application catalog')
    const adminA = await adminContext(orgA)
    const adminB = await adminContext(orgB)
    const created = (await callTool(orgA, create, adminA, {
      entityKey: 'tax-codes', body: { code: 'DEL-VAT', name: 'Delete me', isActive: true }, idempotencyKey: randomUUID(),
    })) as { id: string }
    const id = created.id
    // Cross-org isolation: org B's admin cannot delete org A's row.
    await assert.rejects(
      callTool(orgB, tool, adminB, { entityKey: 'tax-codes', id, idempotencyKey: randomUUID() }),
      /not found/,
    )
    assert.equal((await withOrgContext(orgA.orgId, () => db.execute(sql`select id from tax_codes where id = ${id} and org_id = ${orgA.orgId}`))).rows.length, 1)
    // Permission refusal: a non-admin deletes nothing.
    await assert.rejects(
      callTool(orgA, tool, await viewerContext(orgA), { entityKey: 'tax-codes', id, idempotencyKey: randomUUID() }),
      /forbidden/,
    )
    assert.equal((await withOrgContext(orgA.orgId, () => db.execute(sql`select id from tax_codes where id = ${id} and org_id = ${orgA.orgId}`))).rows.length, 1)
    const key = randomUUID()
    const first = await callTool(orgA, tool, adminA, { entityKey: 'tax-codes', id, idempotencyKey: key })
    assert.equal(first.ok, true)
    assert.equal(first.replayed, false)
    assert.equal((await withOrgContext(orgA.orgId, () => db.execute(sql`select id from tax_codes where id = ${id} and org_id = ${orgA.orgId}`))).rows.length, 0)
    const replay = await callTool(orgA, tool, adminA, { entityKey: 'tax-codes', id, idempotencyKey: key })
    assert.equal(replay.ok, true)
    assert.equal(replay.replayed, true)
  } finally {
    await dropScratchOrg(orgA.orgId)
    await dropScratchOrg(orgB.orgId)
  }
})

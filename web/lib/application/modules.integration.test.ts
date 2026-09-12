import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

/**
 * Modules as an agent capability, exercised against a real tenant.
 *
 * The manifest unit tests prove the contract's rules. This proves the parts
 * only a database can: that the permission actually gates, that a
 * zero-capability page-only install self-applies with audit while a
 * capability-bearing one stages a signed approval gate and projects nothing
 * until a distinct approver applies it, that diff reports per-kind
 * added/changed/removed, and that rollback restores the previous version's
 * projections while marking the bad version rolled back.
 */

const root = pathToFileURL(process.cwd() + '/web/').href
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    if (specifier.startsWith('@/')) return next(root + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})

const { sql } = await import('drizzle-orm')
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  '@openbooks/engine/src/test-fixtures.ts'
)
const modules = await import('./modules')

type Ctx = Parameters<typeof modules.listModules>[0]

function contextFor(orgId: string, userId: string, permissions: string[]): Ctx {
  return {
    authz: {
      user: { id: userId, orgId, name: 'Test', email: 't@example.test', roles: [] },
      permissions: new Set(permissions),
      allowedSubsidiaryIds: null,
    },
    source: 'mcp',
    requestId: randomUUID(),
    apiKeyId: null,
  } as unknown as Ctx
}

/** A realistic PageSpec document; the installer stores it opaquely as jsonb. */
function specFor(route: string, extra: Record<string, unknown> = {}) {
  return { specVersion: 1, route, layout: 'list', header: [], body: [], ...extra }
}

/** A zero-capability page-only manifest: the self-applying shape. */
function pageOnlyManifest(overrides: Record<string, unknown> = {}) {
  return {
    key: 'agent-atlas',
    name: 'Agent Atlas',
    version: '1.0.0',
    permissions: [],
    contributions: [{ kind: 'page', route: '/atlas/one', spec: specFor('/atlas/one') }],
    ...overrides,
  }
}

/** A capability-bearing manifest: approval-gated by construction. */
function capabilityManifest(overrides: Record<string, unknown> = {}) {
  return {
    key: 'agent-ledger',
    name: 'Agent Ledger',
    version: '1.0.0',
    permissions: ['records.read'],
    contributions: [{ kind: 'page', route: '/ledger/one', spec: specFor('/ledger/one') }],
    ...overrides,
  }
}

const FULL = ['admin.customization.manage', 'records.read']

test('module agent tools gate, self-apply page-only installs, and stage capability installs', async (t) => {
  const { orgA, orgB, requesterA, approverA, userB } = await withBypassContext(async () => {
    const a = await createScratchOrg()
    const b = await createScratchOrg()
    return {
      orgA: a.orgId,
      orgB: b.orgId,
      requesterA: await createScratchUser(a.orgId, 'Module Requester', 'admin'),
      approverA: await createScratchUser(a.orgId, 'Module Approver', 'admin'),
      userB: await createScratchUser(b.orgId, 'Other Admin', 'admin'),
    }
  })
  t.after(async () => {
    await withBypassContext(async () => {
      await dropScratchOrg(orgA)
      await dropScratchOrg(orgB)
    })
  })

  const requester = contextFor(orgA, requesterA, FULL)
  const approver = contextFor(orgA, approverA, FULL)
  const reader = contextFor(orgA, requesterA, ['reports.read'])
  const otherOrg = contextFor(orgB, userB, FULL)

  await withOrgContext(orgA, async () => {
    // The permission gates every entry point, not just the writes. Reading
    // what modules an org installed is itself administrative.
    for (const call of [
      () => modules.describeModuleVocabulary(reader),
      () => modules.listModules(reader),
      () => modules.validateModule(reader, { manifest: pageOnlyManifest() }),
      () => modules.installModuleStaged(reader, { manifest: pageOnlyManifest() }),
      () => modules.diffModule(reader, { manifest: pageOnlyManifest() }),
      () => modules.applyModule(reader, { gateId: randomUUID() }),
      () => modules.rollbackModule(reader, { key: 'agent-atlas' }),
    ]) {
      await assert.rejects(call, /forbidden/i, 'a reader must not reach module tools')
    }

    // The vocabulary names the kinds, their projection targets, and the
    // permission catalogue — an author that cannot enumerate them invents
    // one, and an invented kind is a refused install at best.
    const vocab = await modules.describeModuleVocabulary(requester)
    assert.ok(vocab.contributionKinds.includes('page'))
    assert.equal(vocab.projectionTargets.page, 'page_specs')
    assert.ok(vocab.permissions.includes('records.read'))
    assert.ok(vocab.rules.length > 0)

    // A draft is checkable without storing anything, and the errors name
    // the defect rather than saying "invalid".
    const bad = await modules.validateModule(requester, {
      manifest: { ...pageOnlyManifest(), permissions: ['no.such.permission'] },
    })
    assert.equal(bad.valid, false)
    assert.ok(bad.errors.some((e) => e.includes('no.such.permission')))
    assert.deepEqual((await modules.listModules(requester)).modules, [], 'validating stores nothing')

    const good = await modules.validateModule(requester, { manifest: pageOnlyManifest() })
    assert.equal(good.valid, true)
    assert.deepEqual(good.errors, [])

    // A zero-capability page-only install self-applies: no gate, live rows.
    const applied = await modules.installModuleStaged(requester, {
      manifest: pageOnlyManifest(),
      reason: 'agent test self-apply',
    })
    assert.equal(applied.applied, true)
    assert.equal(applied.staged, false)
    assert.ok(applied.moduleId)
    assert.ok(applied.versionId)

    const listed = await modules.listModules(requester)
    assert.equal(listed.modules.length, 1)
    assert.equal(listed.modules[0]!.key, 'agent-atlas')
    assert.equal(listed.modules[0]!.status, 'installed')
    assert.equal(listed.modules[0]!.activeVersion?.version, '1.0.0')
    assert.deepEqual(listed.modules[0]!.grantedPermissions, [])

    const specs = (
      await db.execute<{ route: string; module_version_id: string | null }>(
        sql`select route, module_version_id from page_specs where org_id = ${orgA} and is_active`,
      )
    ).rows
    assert.equal(specs.length, 1)
    assert.equal(specs[0]!.route, '/atlas/one')
    assert.equal(specs[0]!.module_version_id, applied.versionId)

    // Every self-apply write names its actor and carries before/after/reason.
    const audit = (
      await db.execute<{ changes: { reason?: unknown } }>(
        sql`select changes from audit_log where org_id = ${orgA} and table_name = 'modules'`,
      )
    ).rows
    assert.ok(audit.length > 0, 'the self-apply wrote module audit rows')
    for (const row of audit) assert.equal(typeof row.changes.reason, 'string')

    // A capability-bearing install stages an approval instead: a pending
    // gate, a signature requirement, and zero projected rows.
    const staged = await modules.installModuleStaged(requester, {
      manifest: capabilityManifest(),
      approverUserId: approverA,
      reason: 'agent test staged install',
    })
    assert.equal(staged.applied, false)
    assert.equal(staged.staged, true)
    assert.equal(staged.gateIds.length, 1)
    assert.equal(staged.signatureRequired, true)
    assert.deepEqual(staged.granted, ['records.read'])
    assert.ok(staged.runId)

    const gates = (
      await db.execute<{ status: string; signature_required: boolean }>(
        sql`select status, signature_required from flow_gates where org_id = ${orgA} and id = ${staged.gateIds[0]!}`,
      )
    ).rows
    assert.equal(gates.length, 1)
    assert.equal(gates[0]!.status, 'pending')
    assert.equal(gates[0]!.signature_required, true)

    const stagedSpecs = (
      await db.execute<{ n: string }>(
        sql`select count(*) as n from page_specs where org_id = ${orgA} and route = '/ledger/one' and is_active`,
      )
    ).rows
    assert.equal(Number(stagedSpecs[0]!.n), 0, 'a staged proposal projects nothing')

    // Separation of duties: the requester cannot apply their own install.
    await assert.rejects(
      modules.applyModule(requester, { gateId: staged.gateIds[0]!, signature: 'requester-signs' }),
      /own module install/,
      'self-approval must be refused',
    )

    // A signature is required for capability-bearing versions: approving
    // without one fails, with one activates.
    await assert.rejects(
      modules.applyModule(approver, { gateId: staged.gateIds[0]! }),
      /signature/i,
      'a capability-bearing apply without a signature must fail',
    )
    const decided = await modules.applyModule(approver, {
      gateId: staged.gateIds[0]!,
      signature: 'approver-signs',
      comment: 'reviewed',
    })
    assert.equal(decided.applied, true)
    assert.equal(decided.versionStatus, 'active')

    const liveLedger = (
      await db.execute<{ route: string }>(
        sql`select route from page_specs where org_id = ${orgA} and route = '/ledger/one' and is_active`,
      )
    ).rows
    assert.equal(liveLedger.length, 1, 'approval projects the staged page')

    const grant = (
      await db.execute<{ granted_permissions: string[] }>(
        sql`select granted_permissions from modules where org_id = ${orgA} and key = 'agent-ledger'`,
      )
    ).rows[0]!
    assert.deepEqual(grant.granted_permissions, ['records.read'])
  })

  // The other org sees none of it.
  await withOrgContext(orgB, async () => {
    assert.deepEqual((await modules.listModules(otherOrg)).modules, [])
  })
})

test('module diff reports per-kind changes and rollback restores the prior version', async (t) => {
  const { orgId, requesterId } = await withBypassContext(async () => {
    const org = await createScratchOrg()
    return { orgId: org.orgId, requesterId: await createScratchUser(org.orgId, 'Module Agent', 'admin') }
  })
  t.after(async () => {
    await withBypassContext(async () => {
      await dropScratchOrg(orgId)
    })
  })
  const actor = contextFor(orgId, requesterId, FULL)

  await withOrgContext(orgId, async () => {
    // Diffing against nothing installed reports every contribution added.
    const fresh = await modules.diffModule(actor, { manifest: pageOnlyManifest() })
    assert.equal(fresh.compared, true)
    assert.equal(fresh.liveVersion, null)
    assert.equal(fresh.changes.length, 1)
    assert.deepEqual(fresh.changes[0], {
      kind: 'page',
      identity: '/atlas/one',
      change: 'added',
      target: 'page_specs',
    })

    const v1 = await modules.installModuleStaged(actor, { manifest: pageOnlyManifest() })
    assert.equal(v1.applied, true)

    // v2 changes one route's bytes, adds a route, and drops nothing yet.
    const v2manifest = pageOnlyManifest({
      version: '1.1.0',
      contributions: [
        { kind: 'page', route: '/atlas/one', spec: specFor('/atlas/one', { layout: 'detail' }) },
        { kind: 'page', route: '/atlas/two', spec: specFor('/atlas/two') },
      ],
    })
    const diff = await modules.diffModule(actor, { manifest: v2manifest })
    assert.equal(diff.compared, true)
    assert.equal(diff.liveVersion, '1.0.0')
    assert.equal(diff.proposedVersion, '1.1.0')
    const byIdentity = new Map(diff.changes.map((c) => [c.identity, c.change]))
    assert.equal(byIdentity.get('/atlas/one'), 'changed')
    assert.equal(byIdentity.get('/atlas/two'), 'added')
    assert.equal(diff.requiresReapproval, false, 'a page-only narrowing needs no new grant')

    // A permission addition is a capability change: re-approval required.
    const widening = await modules.diffModule(actor, {
      manifest: pageOnlyManifest({ version: '1.1.0', permissions: ['records.read'] }),
    })
    assert.equal(widening.compared, true)
    if (!widening.compared) throw new Error('expected the widening diff to compare')
    assert.deepEqual(widening.permissions.added, ['records.read'])
    assert.equal(widening.requiresReapproval, true)

    const v2 = await modules.installModuleStaged(actor, { manifest: v2manifest })
    assert.equal(v2.applied, true)
    assert.equal((await modules.listModules(actor)).modules[0]!.activeVersion?.version, '1.1.0')

    // Rolling back to the 1.0.0 version restores its projections and marks
    // the bad version rolled back — history is appended, never rewritten.
    const rolled = await modules.rollbackModule(actor, { key: 'agent-atlas', versionId: v1.versionId! })
    assert.equal(rolled.rolledBack, true)
    assert.equal(rolled.versionId, v1.versionId)
    assert.deepEqual(rolled.markedRolledBack, [v2.versionId!])

    const live = (
      await db.execute<{ route: string }>(
        sql`select route from page_specs where org_id = ${orgId} and is_active and module_version_id is not null order by route`,
      )
    ).rows.map((r) => r.route)
    assert.deepEqual(live, ['/atlas/one'], 'the dropped v2 route is withdrawn')

    const one = (
      await db.execute<{ spec: unknown }>(
        sql`select spec from page_specs where org_id = ${orgId} and route = '/atlas/one' and is_active`,
      )
    ).rows[0]!
    assert.deepEqual(one.spec, specFor('/atlas/one'), 'the v1 bytes are live again')

    const statuses = (
      await db.execute<{ version: string; status: string }>(
        sql`select mv.version, mv.status from module_versions mv
             join modules m on m.org_id = mv.org_id and m.id = mv.module_id
            where mv.org_id = ${orgId} and m.key = 'agent-atlas' order by mv.version`,
      )
    ).rows
    assert.deepEqual(
      statuses.map((s) => [s.version, s.status]),
      [['1.0.0', 'active'], ['1.1.0', 'rolled_back']],
    )

    // Rolling back the version that is already live is refused, not a no-op
    // pretending to be work.
    const refused = await modules.rollbackModule(actor, { key: 'agent-atlas', versionId: v1.versionId! })
    assert.equal(refused.rolledBack, false)
    assert.ok(refused.errors.length > 0)

    // An unknown module key is a named refusal, not an exception.
    const unknown = await modules.rollbackModule(actor, { key: 'no-such-module' })
    assert.equal(unknown.rolledBack, false)
    assert.ok(unknown.errors.some((e) => e.includes('no-such-module')))
  })
})

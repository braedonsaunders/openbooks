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

const { installApp, runBridgeMethod } = await import('./store')
const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  '@openbooks/engine/src/testing/fixtures.ts',
)

const DB = !!env.OPENBOOKS_DB_URL

/**
 * Regression coverage (app-sandbox records adapter): runBridgeMethod received
 * the caller's allowedSubsidiaryIds, but the records adapter behind
 * `records.list` / `records.get` dropped it — a caller restricted to one
 * legal entity could read custom records parked in a hidden entity through
 * any installed App holding records.read. The adapter now carries the same
 * JSON subsidiary fence the platform adapter enforces.
 */

type Fixture = {
  org: Awaited<ReturnType<typeof createScratchOrg>>
  actorId: string
  branchId: string
  typeKey: string
  plainTypeKey: string
  visibleId: string
  hiddenId: string
  user: Parameters<typeof runBridgeMethod>[0]['user']
}

async function makeFixture(): Promise<Fixture> {
  const typeKey = `bridgerec-${randomUUID().replaceAll('-', '').slice(0, 12)}`
  const plainTypeKey = `bridgeno-${randomUUID().replaceAll('-', '').slice(0, 12)}`
  return await withBypass(async () => {
    const org = await createScratchOrg()
    const { adminId } = await seedFlowActors(org.orgId)
    const branch = randomUUID()
    const scopedTypeId = randomUUID()
    const plainTypeId = randomUUID()
    const visible = randomUUID()
    const hidden = randomUUID()
    const plain = randomUUID()
    const scopedFields = [{
      id: 'main',
      title: 'Details',
      fields: [
        { id: 'subsidiary_id', type: 'text', label: 'Subsidiary' },
        { id: 'title', type: 'text', label: 'Title' },
      ],
    }]
    const plainFields = [{
      id: 'main',
      title: 'Details',
      fields: [{ id: 'title', type: 'text', label: 'Title' }],
    }]
    await db.execute(sql`
      insert into subsidiaries
        (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values
        (${branch}, ${org.orgId}, ${org.subsidiaryId}, 'Bridge Branch', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)
    `)
    for (const [typeId, key, name, fields] of [
      [scopedTypeId, typeKey, 'Bridge Scoped', scopedFields],
      [plainTypeId, plainTypeKey, 'Bridge Plain', plainFields],
    ] as const) {
      await db.execute(sql`
        insert into custom_record_types
          (id, org_id, key, name, plural_name, fields, status, created_by, updated_by)
        values
          (${typeId}, ${org.orgId}, ${key}, ${name}, ${name},
           ${JSON.stringify(fields)}::jsonb, 'published', ${adminId}, ${adminId})
      `)
    }
    for (const [id, subsidiaryId, title] of [
      [visible, org.subsidiaryId, 'visible'] as const,
      [hidden, branch, 'hidden'] as const,
    ]) {
      await db.execute(sql`
        insert into custom_records
          (id, org_id, type_id, type_key, record_number, data, search_text, status, created_by, updated_by)
        values
          (${id}, ${org.orgId}, ${scopedTypeId}, ${typeKey}, ${id},
           ${JSON.stringify({ subsidiary_id: subsidiaryId, title })}::jsonb,
           ${title}, 'active', ${adminId}, ${adminId})
      `)
    }
    await db.execute(sql`
      insert into custom_records
        (id, org_id, type_id, type_key, record_number, data, search_text, status, created_by, updated_by)
      values
        (${plain}, ${org.orgId}, ${plainTypeId}, ${plainTypeKey}, ${plain},
         ${JSON.stringify({ title: 'plain' })}::jsonb,
         'plain', 'active', ${adminId}, ${adminId})
    `)
    const user = {
      id: adminId,
      email: 'bridge-scope@scratch.test',
      name: 'Bridge Scope Caller',
      roles: [{ key: 'admin', name: 'Admin' }],
      orgId: org.orgId,
      envKind: 'production' as const,
      productionOrgId: org.orgId,
      isSuperAdmin: false,
      homeUserId: adminId,
      homeOrgId: org.orgId,
    }
    return { org, actorId: adminId, branchId: branch, typeKey, plainTypeKey, visibleId: visible, hiddenId: hidden, user }
  })
}

async function installRecordsApp(fx: Fixture): Promise<string> {
  const key = `bridgeproof-${randomUUID().slice(0, 8)}`
  await withBypass(() =>
    installApp(fx.org.orgId, fx.actorId, {
      manifest: {
        key,
        name: 'Bridge Records Proof App',
        version: '1.0.0',
        description: '',
        permissions: ['records.read'],
        frontend: { entry: 'frontend/index.html' },
      },
      files: [{ path: 'frontend/index.html', content: '<html><body>proof</body></html>' }],
    }),
  )
  return key
}

test('bridge records.list/get honor the caller subsidiary fence on JSON subsidiary_id', { skip: !DB }, async () => {
  const fx = await makeFixture()
  try {
    const appKey = await installRecordsApp(fx)
    const scope = new Set([fx.org.subsidiaryId])
    const base = {
      orgId: fx.org.orgId,
      user: fx.user,
      key: appKey,
      userCan: () => true,
      allowedSubsidiaryIds: scope as ReadonlySet<string> | null,
    }

    const listed = await withOrgContext(fx.org.orgId, () =>
      runBridgeMethod({ ...base, method: 'records.list', payload: { typeKey: fx.typeKey } }),
    )
    assert.equal(listed.ok, true, JSON.stringify(listed))
    const rows = (listed as { result?: Array<{ id: string }> }).result ?? []
    assert.deepEqual(rows.map((r) => r.id), [fx.visibleId])

    const gotVisible = await withOrgContext(fx.org.orgId, () =>
      runBridgeMethod({ ...base, method: 'records.get', payload: { typeKey: fx.typeKey, id: fx.visibleId } }),
    )
    assert.equal(gotVisible.ok, true, JSON.stringify(gotVisible))
    assert.equal((gotVisible as { result?: { id: string } }).result?.id, fx.visibleId)

    const gotHidden = await withOrgContext(fx.org.orgId, () =>
      runBridgeMethod({ ...base, method: 'records.get', payload: { typeKey: fx.typeKey, id: fx.hiddenId } }),
    )
    assert.equal(gotHidden.ok, true, JSON.stringify(gotHidden))
    assert.equal((gotHidden as { result?: unknown }).result, null)

    // Unrestricted callers still see every entity; types without a
    // subsidiary field stay fully visible to a restricted caller.
    const unscoped = await withOrgContext(fx.org.orgId, () =>
      runBridgeMethod({
        ...base,
        method: 'records.list',
        payload: { typeKey: fx.typeKey },
        allowedSubsidiaryIds: null,
      }),
    )
    assert.equal(unscoped.ok, true, JSON.stringify(unscoped))
    assert.equal(((unscoped as { result?: unknown[] }).result ?? []).length, 2)

    const plain = await withOrgContext(fx.org.orgId, () =>
      runBridgeMethod({ ...base, method: 'records.list', payload: { typeKey: fx.plainTypeKey } }),
    )
    assert.equal(plain.ok, true, JSON.stringify(plain))
    assert.equal(((plain as { result?: unknown[] }).result ?? []).length, 1)
  } finally {
    await withBypass(() => dropScratchOrg(fx.org.orgId))
  }
})

test('bridge records.list/get still hide stored JSON subsidiary_id after the type drops the field', { skip: !DB }, async () => {
  const typeKey = `bridgedrop-${randomUUID().replaceAll('-', '').slice(0, 10)}`
  const visibleId = randomUUID()
  const hiddenId = randomUUID()
  const fx = await withBypass(async () => {
    const org = await createScratchOrg()
    const { adminId } = await seedFlowActors(org.orgId)
    const branch = randomUUID()
    const typeId = randomUUID()
    const fields = [{
      id: 'main',
      title: 'Details',
      fields: [{ id: 'title', type: 'text', label: 'Title' }],
    }]
    await db.execute(sql`
      insert into subsidiaries
        (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values
        (${branch}, ${org.orgId}, ${org.subsidiaryId}, 'Bridge Dropped Branch', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)
    `)
    await db.execute(sql`
      insert into custom_record_types
        (id, org_id, key, name, plural_name, fields, status, created_by, updated_by)
      values
        (${typeId}, ${org.orgId}, ${typeKey}, 'Bridge Dropped', 'Bridge Dropped',
         ${JSON.stringify(fields)}::jsonb, 'published', ${adminId}, ${adminId})
    `)
    for (const [id, subsidiaryId, title] of [
      [visibleId, org.subsidiaryId, 'visible'] as const,
      [hiddenId, branch, 'hidden'] as const,
    ]) {
      await db.execute(sql`
        insert into custom_records
          (id, org_id, type_id, type_key, record_number, data, search_text, status, created_by, updated_by)
        values
          (${id}, ${org.orgId}, ${typeId}, ${typeKey}, ${id},
           ${JSON.stringify({ subsidiary_id: subsidiaryId, title })}::jsonb,
           ${title}, 'active', ${adminId}, ${adminId})
      `)
    }
    const user = {
      id: adminId,
      email: 'bridge-drop@scratch.test',
      name: 'Bridge Drop Caller',
      roles: [{ key: 'admin', name: 'Admin' }],
      orgId: org.orgId,
      envKind: 'production' as const,
      productionOrgId: org.orgId,
      isSuperAdmin: false,
      homeUserId: adminId,
      homeOrgId: org.orgId,
    }
    return { org, actorId: adminId, user }
  })
  try {
    const appKey = await installRecordsApp({
      org: fx.org,
      actorId: fx.actorId,
      branchId: '',
      typeKey,
      plainTypeKey: '',
      visibleId,
      hiddenId,
      user: fx.user,
    })
    const base = {
      orgId: fx.org.orgId,
      user: fx.user,
      key: appKey,
      userCan: () => true,
      allowedSubsidiaryIds: new Set([fx.org.subsidiaryId]) as ReadonlySet<string> | null,
    }
    const listed = await withOrgContext(fx.org.orgId, () =>
      runBridgeMethod({ ...base, method: 'records.list', payload: { typeKey } }),
    )
    assert.equal(listed.ok, true, JSON.stringify(listed))
    const rows = (listed as { result?: Array<{ id: string }> }).result ?? []
    assert.deepEqual(rows.map((r) => r.id), [visibleId])

    const gotHidden = await withOrgContext(fx.org.orgId, () =>
      runBridgeMethod({ ...base, method: 'records.get', payload: { typeKey, id: hiddenId } }),
    )
    assert.equal(gotHidden.ok, true, JSON.stringify(gotHidden))
    assert.equal((gotHidden as { result?: unknown }).result, null)
  } finally {
    await withBypass(() => dropScratchOrg(fx.org.orgId))
  }
})

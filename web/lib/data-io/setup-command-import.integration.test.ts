import assert from 'node:assert/strict'
import test from 'node:test'
import { sql } from 'drizzle-orm'

// Server-only shim so this DB test can import the resource under node.
const { setupDescriptor, setupResource } = (await import('./setup-resources.ts')) as typeof import('./setup-resources.ts')
const { SETUP_ENTITIES, SETUP_ENTITY_BY_KEY } = await import('../setup/registry.ts')

const { db } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrgReporting } = await import('@openbooks/engine/src/testing/fixtures.ts')

const DB = { skip: !process.env.OPENBOOKS_DB_URL }

/** A zero-row feature update must fail instead of testing unchanged defaults. */
async function setImportFeatures(orgId: string, flags: Record<string, boolean>): Promise<void> {
  const updated = await db.execute(sql`update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}', coalesce(settings->'features', '{}'::jsonb) || ${JSON.stringify(flags)}::jsonb, true) where id = ${orgId} returning id`)
  assert.equal(updated.rows.length, 1, 'the feature fixture must update its organization')
}

async function seedChannel(orgId: string, actorId: string, name: string): Promise<string> {
  const inserted = (await db.execute<{ id: string }>(sql`
    insert into sales_channels (org_id, kind, name, status, currency, external_account, settings, created_by, updated_by)
    values (${orgId}, 'shopify', ${name}, 'active', 'USD', ${`${name}.myshopify.com`}, '{}'::jsonb, ${actorId}, ${actorId})
    returning id`))
  const id = inserted.rows[0]?.id
  assert.ok(id)
  return id
}

test('command-owned setup entities stay importable and bar sealed configuration', DB, async () => {
  const commanded = SETUP_ENTITIES.filter((entity) => entity.importVia === 'command').map((entity) => entity.key).sort()
  for (const key of ['channel-account-maps', 'channel-ad-spend', 'channel-locations']) {
    assert.ok(commanded.includes(key), `${key} must import through its domain command`)
  }
  for (const entity of SETUP_ENTITIES.filter((candidate) => candidate.importVia === 'command')) {
    assert.equal(setupDescriptor(entity).supportsImport, true, `${entity.key} must stay importable`)
  }
  const barred = SETUP_ENTITIES.filter((entity) => entity.importVia === 'none').map((entity) => entity.key)
  assert.ok(barred.length > 0, 'the refusal test below is vacuous without a barred entity')
  for (const key of ['nonprofit-frameworks', 'fund-pairs', 'functional-mappings', 'dunning-policies', 'quote-to-cash-policy', 'customer-portal']) {
    assert.ok(barred.includes(key), `${key} must stay barred from import`)
  }
  const frameworks = SETUP_ENTITY_BY_KEY.get('nonprofit-frameworks')
  assert.ok(frameworks)
  assert.equal(setupDescriptor(frameworks).supportsImport, false)
})

test('account map imports close the prior open row through the command and audit', DB, async () => {
  const org = await createScratchOrg()
  try {
    const actorId = await createScratchUser(org.orgId, 'Map Import Admin', 'admin')
    await setImportFeatures(org.orgId, { salesChannels: true })
    const channelId = await seedChannel(org.orgId, actorId, 'Maple Shop')
    const { upsertAccountMap } = await import('@openbooks/engine/src/commerce/account-maps.ts')
    await upsertAccountMap(org.orgId, actorId, {
      channelId,
      role: 'revenue',
      accountId: org.accounts.revenue,
      effectiveFrom: '2026-01-01',
    })
    const entity = SETUP_ENTITY_BY_KEY.get('channel-account-maps')
    assert.ok(entity)
    const resource = setupResource(entity, org.orgId)
    const outcome = await resource.write(
      [{ channelId: 'Maple Shop', role: 'revenue', key: '', accountId: '1000', effectiveFrom: '2026-06-01' }],
      'upsert',
      { orgId: org.orgId, actorId, dryRun: false, permissions: new Set(['channels.manage']) },
    )
    assert.deepEqual({ created: outcome.created, updated: outcome.updated, failed: outcome.failed }, { created: 0, updated: 1, failed: 0 })
    // The prior open row closes the day before the successor starts; the new
    // row carries the imported account. A raw insert could never close it.
    const rows = (await db.execute<{ account_id: string; effective_from: string; effective_to: string | null }>(sql`
      select account_id, effective_from::text as effective_from, effective_to::text as effective_to
        from sales_channel_account_maps
       where org_id = ${org.orgId} and role = 'revenue' and key = ''
       order by effective_from`)).rows
    assert.deepEqual(rows.map((row) => [row.account_id, row.effective_from, row.effective_to]), [
      [org.accounts.revenue, '2026-01-01', '2026-05-31'],
      [org.accounts.bank, '2026-06-01', null],
    ])
    // Both the close-out and the new row carry audit evidence for the actor.
    const audits = (await db.execute<{ action: string; actor_id: string }>(sql`
      select action, actor_id from audit_log
       where org_id = ${org.orgId} and table_name = 'sales_channel_account_maps'`)).rows
    assert.deepEqual(audits.map((row) => row.action).sort(), ['insert', 'insert', 'update'])
    assert.ok(audits.every((row) => row.actor_id === actorId))
  } finally {
    await dropScratchOrgReporting(org.orgId)
  }
})

test('account map imports refuse while Sales Channels is off and store nothing', DB, async () => {
  const org = await createScratchOrg()
  try {
    const actorId = await createScratchUser(org.orgId, 'Map Import Admin', 'admin')
    await seedChannel(org.orgId, actorId, 'Maple Shop')
    const entity = SETUP_ENTITY_BY_KEY.get('channel-account-maps')
    assert.ok(entity)
    const outcome = await setupResource(entity, org.orgId).write(
      [{ channelId: 'Maple Shop', role: 'revenue', key: '', accountId: '1000', effectiveFrom: '2026-06-01' }],
      'upsert',
      { orgId: org.orgId, actorId, dryRun: false, permissions: new Set(['channels.manage']) },
    )
    assert.equal(outcome.created, 0)
    assert.equal(outcome.failed, 1)
    assert.match(outcome.errors[0]?.message ?? '', /not available/i)
    const stored = (await db.execute<{ count: number }>(sql`
      select count(*)::int as count from sales_channel_account_maps where org_id = ${org.orgId}`)).rows[0]?.count
    assert.equal(stored, 0)
  } finally {
    await dropScratchOrgReporting(org.orgId)
  }
})

test('location imports refresh the mapping in place through the command and audit', DB, async () => {
  const org = await createScratchOrg()
  try {
    const actorId = await createScratchUser(org.orgId, 'Location Import Admin', 'admin')
    await setImportFeatures(org.orgId, { salesChannels: true })
    await seedChannel(org.orgId, actorId, 'Maple Shop')
    const entity = SETUP_ENTITY_BY_KEY.get('channel-locations')
    assert.ok(entity)
    const resource = setupResource(entity, org.orgId)
    const ctx = { orgId: org.orgId, actorId, dryRun: false, permissions: new Set(['channels.manage']) }
    const first = await resource.write(
      [{
        channelId: 'Maple Shop',
        externalLocationId: 'loc-1',
        externalName: 'Toronto warehouse',
        stockLocationId: org.stockLocationId,
        syncInventory: true,
        bufferQuantity: '2',
      }],
      'upsert',
      ctx,
    )
    assert.deepEqual({ created: first.created, updated: first.updated, failed: first.failed }, { created: 1, updated: 0, failed: 0 })
    const second = await resource.write(
      [{
        channelId: 'Maple Shop',
        externalLocationId: 'loc-1',
        externalName: 'Toronto flagship',
        stockLocationId: org.stockLocationId2,
        syncInventory: false,
        bufferQuantity: '2',
      }],
      'upsert',
      ctx,
    )
    assert.deepEqual({ created: second.created, updated: second.updated, failed: second.failed }, { created: 0, updated: 1, failed: 0 })
    // A re-sync refreshes the one mapping instead of stacking a duplicate.
    const rows = (await db.execute<{ id: string; external_name: string; buffer_quantity: string }>(sql`
      select id, external_name, buffer_quantity::text as buffer_quantity
        from sales_channel_locations where org_id = ${org.orgId}`)).rows
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.external_name, 'Toronto flagship')
    assert.equal(rows[0]?.buffer_quantity, '2.0000')
    const audits = (await db.execute<{ action: string }>(sql`
      select action from audit_log
       where org_id = ${org.orgId} and table_name = 'sales_channel_locations' order by id`)).rows
    assert.deepEqual(audits.map((row) => row.action), ['insert', 'update'])
  } finally {
    await dropScratchOrgReporting(org.orgId)
  }
})

test('barred configuration is refused by name on import and stores nothing', DB, async () => {
  const org = await createScratchOrg()
  try {
    const actorId = await createScratchUser(org.orgId, 'Barred Import Admin', 'admin')
    const barred = SETUP_ENTITIES.filter((entity) => entity.importVia === 'none')
    assert.ok(barred.length > 0)
    for (const entity of barred) {
      const outcome = await setupResource(entity, org.orgId).write(
        [{ [entity.fields[0]?.key ?? 'name']: 'probe' }],
        'insert',
        {
          orgId: org.orgId,
          actorId,
          dryRun: false,
          permissions: new Set(entity.writePermission ? [entity.writePermission] : []),
        },
      )
      const message = outcome.errors[0]?.message ?? ''
      assert.equal(outcome.created, 0, `${entity.key} stored a row`)
      assert.equal(outcome.updated, 0, `${entity.key} stored a row`)
      assert.equal(outcome.failed, 1, `${entity.key} did not refuse`)
      assert.ok(message.includes(entity.key), `${entity.key} refusal must name the entity: ${message}`)
      assert.match(message, /cannot be imported/, `${entity.key} refusal must say import is barred`)
      if (entity.key === 'dunning-policies') {
        const seeded = (await db.execute<{ id: string }>(sql`
          insert into dunning_policies (org_id, name, is_active, autopay_retry_offsets_days, autopay_insufficient_funds_offsets_days)
          values (${org.orgId}, 'Complete policy export', false, '{2,7}', '{4}') returning id`)).rows
        assert.equal(seeded.length, 1)
        const policy = seeded[0]!
        await db.execute(sql`insert into dunning_stages
          (org_id, policy_id, sequence, name, offset_days, subject_template, body_template, escalate)
          values (${org.orgId}, ${policy.id}, 2, 'Escalate', 14, 'Final reminder', 'Please pay', true),
                 (${org.orgId}, ${policy.id}, 1, 'Reminder', 7, 'First reminder', 'Balance due', false)`)
        const exported = (await setupResource(entity, org.orgId).read()).rows
        assert.equal(exported.length, 1)
        assert.deepEqual(JSON.parse(String(exported[0]!.retryOffsetsDays)), [{ days: 2 }, { days: 7 }])
        assert.deepEqual(JSON.parse(String(exported[0]!.insufficientFundsOffsetsDays)), [{ days: 4 }])
        assert.deepEqual(JSON.parse(String(exported[0]!.stages)), [
          { sequence: 1, name: 'Reminder', offsetDays: 7, subjectTemplate: 'First reminder', bodyTemplate: 'Balance due', escalate: false },
          { sequence: 2, name: 'Escalate', offsetDays: 14, subjectTemplate: 'Final reminder', bodyTemplate: 'Please pay', escalate: true },
        ])
      }
    }
  } finally {
    await dropScratchOrgReporting(org.orgId)
  }
})

test('command imports preview without persisting', DB, async () => {
  const org = await createScratchOrg()
  try {
    const actorId = await createScratchUser(org.orgId, 'Map Preview Admin', 'admin')
    await setImportFeatures(org.orgId, { salesChannels: true })
    await seedChannel(org.orgId, actorId, 'Maple Shop')
    const entity = SETUP_ENTITY_BY_KEY.get('channel-account-maps')
    assert.ok(entity)
    const outcome = await setupResource(entity, org.orgId).write(
      [{ channelId: 'Maple Shop', role: 'revenue', key: '', accountId: '1000', effectiveFrom: '2026-06-01' }],
      'upsert',
      { orgId: org.orgId, actorId, dryRun: true, permissions: new Set(['channels.manage']) },
    )
    assert.deepEqual({ created: outcome.created, updated: outcome.updated, failed: outcome.failed }, { created: 1, updated: 0, failed: 0 })
    const stored = (await db.execute<{ count: number }>(sql`
      select count(*)::int as count from sales_channel_account_maps where org_id = ${org.orgId}`)).rows[0]?.count
    assert.equal(stored, 0)
  } finally {
    await dropScratchOrgReporting(org.orgId)
  }
})

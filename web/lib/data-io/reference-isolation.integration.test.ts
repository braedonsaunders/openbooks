import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

// Data-io resources are server-only. Shim that marker so this focused
// PostgreSQL boundary test can import them under node's test runner.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return {
        shortCircuit: true,
        format: 'module',
        url: 'data:text/javascript,export {}',
      }
    }
    return nextResolve(specifier, context)
  },
})

const { RefResolver } = (await import('./resource-core.ts')) as typeof import('./resource-core.ts')
const { recordResource, recordSections } = (await import('./record-resources.ts')) as typeof import(
  './record-resources.ts'
)
const { MASTER_BY_KEY, masterResource } = (await import('./master-data-resources.ts')) as typeof import(
  './master-data-resources.ts'
)
const { propertyDataResource } = (await import('./property-resources.ts')) as typeof import(
  './property-resources.ts'
)
hooks.deregister()

const { db } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrgReporting } = await import('@openbooks/engine/src/testing/fixtures.ts')

/**
 * Import references are tenant data: a file carrying another org's UUID must
 * not attach to (or disclose) the foreign row. RefResolver used to accept any
 * syntactically valid UUID without an org check, so a custom-record import in
 * one org could persist another org's account id in its schemaless `data`
 * jsonb (no FK to stop it) and the export then rendered the victim's account
 * number via the unscoped label lookup.
 */
test(
  'import references never cross organizations by UUID',
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const orgA = await createScratchOrg()
    const orgB = await createScratchOrg()
    try {
      const victim = (
        await db.execute<{ id: string; number: string }>(sql`
          select id, number from accounts where org_id = ${orgB.orgId} and is_active limit 1`)
      ).rows[0]
      assert.ok(victim)
      const own = (
        await db.execute<{ id: string; number: string }>(sql`
          select id, number from accounts where org_id = ${orgA.orgId} and is_active limit 1`)
      ).rows[0]
      assert.ok(own)

      // resolveId: a foreign UUID is unresolvable; own UUIDs and natural keys
      // keep working so legitimate same-org files are unaffected.
      const resolverA = new RefResolver(orgA.orgId)
      assert.equal(await resolverA.resolveId({ resource: 'accounts', by: 'number' }, victim.id), null)
      assert.equal(await resolverA.resolveId({ resource: 'accounts', by: 'number' }, own.id), own.id)
      assert.equal(
        await resolverA.resolveId({ resource: 'accounts', by: 'number' }, own.number),
        own.id,
      )
      const resolverB = new RefResolver(orgB.orgId)
      assert.equal(await resolverB.resolveId({ resource: 'accounts', by: 'number' }, victim.id), victim.id)

      // resolveLabel: a foreign id falls back to the UUID instead of leaking
      // the victim's natural key into this org's export.
      assert.equal(await resolverA.resolveLabel({ resource: 'accounts', by: 'number' }, victim.id), victim.id)
      assert.equal(await resolverB.resolveLabel({ resource: 'accounts', by: 'number' }, victim.id), victim.number)

      // End to end: the record writer refuses the smuggled reference and
      // persists nothing.
      const typeKey = `xorg_${randomUUID().replaceAll('-', '').slice(0, 12)}`
      const actorA = randomUUID()
      await db.execute(sql`
        insert into custom_record_types (id, org_id, key, name, plural_name, fields, status, created_by, updated_by)
        values (${randomUUID()}, ${orgA.orgId}, ${typeKey}, 'Xorg', 'Xorgs',
          ${JSON.stringify([{ id: 'main', title: 'Main', fields: [
            { id: 'title', type: 'text', label: 'Title' },
            { id: 'acct', type: 'gl_account', label: 'Account' },
          ] }])}::jsonb, 'published', ${actorA}, ${actorA})`)
      const sections = await recordSections(orgA.orgId, typeKey)
      assert.ok(sections)
      const resource = recordResource(orgA.orgId, typeKey, sections, 'Xorgs')
      const outcome = await resource.write(
        [{ title: 'smuggle', acct: victim.id }],
        'insert',
        { orgId: orgA.orgId, actorId: actorA, dryRun: false },
      )
      assert.equal(outcome.created, 0)
      assert.equal(outcome.failed, 1)
      assert.match(outcome.errors[0]?.message ?? '', /not found/)
      const stored = await db.execute<{ count: number }>(sql`
        select count(*)::int as count from custom_records
         where org_id = ${orgA.orgId} and type_key = ${typeKey}`)
      assert.equal(stored.rows[0]?.count, 0)

      // Control: the same row with orgA's own account imports cleanly.
      const accepted = await resource.write(
        [{ title: 'legit', acct: own.number }],
        'insert',
        { orgId: orgA.orgId, actorId: actorA, dryRun: false },
      )
      assert.deepEqual(
        { created: accepted.created, failed: accepted.failed },
        { created: 1, failed: 0 },
      )
    } finally {
      await dropScratchOrgReporting(orgA.orgId)
      await dropScratchOrgReporting(orgB.orgId)
    }
  },
)

/**
 * Setup `ref` sources without a registry entry (items, projects, customers,
 * vendors, employees, trades, accounting periods, sequence kinds) used to
 * fall into the resolver's unknown branch: natural keys were refused and
 * UUIDs passed through blind. They now resolve against their authoritative
 * tables with the same tenant fence, globals keep working, and truly
 * unknown targets fail closed.
 */
test(
  'unregistered reference targets resolve in-org and refuse cross-org',
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const orgA = await createScratchOrg()
    const orgB = await createScratchOrg()
    try {
      // Items by code.
      await db.execute(sql`update items set code = 'VIC-ITEM' where id = ${orgB.items.fifo}`)
      await db.execute(sql`update items set code = 'OWN-ITEM' where id = ${orgA.items.fifo}`)
      // Projects by code.
      const victimProject = randomUUID()
      const ownProject = randomUUID()
      await db.execute(sql`insert into projects (id, org_id, name, code) values (${victimProject}, ${orgB.orgId}, 'Victim', 'VIC-P')`)
      await db.execute(sql`insert into projects (id, org_id, name, code) values (${ownProject}, ${orgA.orgId}, 'Own', 'OWN-P')`)
      // Role-filtered parties: scratch seeds the parties, the roles are added here.
      await db.execute(sql`update parties set short_code = 'VIC-CUST' where id = ${orgB.customerId}`)
      await db.execute(sql`update parties set short_code = 'OWN-CUST' where id = ${orgA.customerId}`)
      await db.execute(sql`insert into customer_roles (org_id, party_id) values (${orgB.orgId}, ${orgB.customerId})`)
      await db.execute(sql`insert into customer_roles (org_id, party_id) values (${orgA.orgId}, ${orgA.customerId})`)
      await db.execute(sql`insert into vendor_roles (org_id, party_id) values (${orgB.orgId}, ${orgB.vendorId})`)
      await db.execute(sql`insert into vendor_roles (org_id, party_id) values (${orgA.orgId}, ${orgA.vendorId})`)
      const victimEmployee = randomUUID()
      const ownEmployee = randomUUID()
      await db.execute(sql`insert into parties (id, org_id, kind, display_name, short_code) values (${victimEmployee}, ${orgB.orgId}, 'person', 'Vic Employee', 'VIC-E')`)
      await db.execute(sql`insert into parties (id, org_id, kind, display_name, short_code) values (${ownEmployee}, ${orgA.orgId}, 'person', 'Own Employee', 'OWN-E')`)
      await db.execute(sql`insert into employee_roles (org_id, party_id, employee_number) values (${orgB.orgId}, ${victimEmployee}, 'E-VIC')`)
      await db.execute(sql`insert into employee_roles (org_id, party_id, employee_number) values (${orgA.orgId}, ${ownEmployee}, 'E-OWN')`)
      // Trades by name; periods by seeded name.
      await db.execute(sql`insert into trades (org_id, name) values (${orgB.orgId}, 'Victim Trade')`)
      await db.execute(sql`insert into trades (org_id, name) values (${orgA.orgId}, 'Own Trade')`)
      const ownPeriod = (await db.execute<{ id: string; name: string }>(sql`
        select id, name from accounting_periods where org_id = ${orgA.orgId} limit 1`)).rows[0]
      const victimPeriod = (await db.execute<{ id: string; name: string }>(sql`
        select id, name from accounting_periods where org_id = ${orgB.orgId} limit 1`)).rows[0]
      assert.ok(ownPeriod && victimPeriod)

      const resolverA = new RefResolver(orgA.orgId)
      const itemTarget = { resource: 'items', by: 'code' }
      assert.equal(await resolverA.resolveId(itemTarget, orgB.items.fifo), null)
      assert.equal(await resolverA.resolveId(itemTarget, 'VIC-ITEM'), null)
      assert.equal(await resolverA.resolveId(itemTarget, orgA.items.fifo), orgA.items.fifo)
      assert.equal(await resolverA.resolveId(itemTarget, 'OWN-ITEM'), orgA.items.fifo)
      assert.equal(await resolverA.resolveLabel(itemTarget, orgB.items.fifo), orgB.items.fifo)
      assert.equal(await resolverA.resolveLabel(itemTarget, orgA.items.fifo), 'OWN-ITEM')

      const projectTarget = { resource: 'projects', by: 'code' }
      assert.equal(await resolverA.resolveId(projectTarget, victimProject), null)
      assert.equal(await resolverA.resolveId(projectTarget, 'VIC-P'), null)
      assert.equal(await resolverA.resolveId(projectTarget, ownProject), ownProject)
      assert.equal(await resolverA.resolveId(projectTarget, 'OWN-P'), ownProject)

      const customerTarget = { resource: 'customers', by: 'short_code' }
      assert.equal(await resolverA.resolveId(customerTarget, orgB.customerId), null)
      assert.equal(await resolverA.resolveId(customerTarget, 'VIC-CUST'), null)
      assert.equal(await resolverA.resolveId(customerTarget, orgA.customerId), orgA.customerId)
      assert.equal(await resolverA.resolveId(customerTarget, 'OWN-CUST'), orgA.customerId)

      const vendorTarget = { resource: 'vendors', by: 'short_code' }
      assert.equal(await resolverA.resolveId(vendorTarget, orgB.vendorId), null)
      assert.equal(await resolverA.resolveId(vendorTarget, orgA.vendorId), orgA.vendorId)

      const employeeTarget = { resource: 'employees', by: 'short_code' }
      assert.equal(await resolverA.resolveId(employeeTarget, victimEmployee), null)
      assert.equal(await resolverA.resolveId(employeeTarget, ownEmployee), ownEmployee)
      assert.equal(await resolverA.resolveId(employeeTarget, 'E-OWN'), ownEmployee)
      assert.equal(await resolverA.resolveId(employeeTarget, 'E-VIC'), null)

      const tradeTarget = { resource: 'trades', by: 'name' }
      const victimTrade = (await db.execute<{ id: string }>(sql`
        select id from trades where org_id = ${orgB.orgId} limit 1`)).rows[0]!.id
      const ownTrade = (await db.execute<{ id: string }>(sql`
        select id from trades where org_id = ${orgA.orgId} limit 1`)).rows[0]!.id
      assert.equal(await resolverA.resolveId(tradeTarget, victimTrade), null)
      assert.equal(await resolverA.resolveId(tradeTarget, 'Victim Trade'), null)
      assert.equal(await resolverA.resolveId(tradeTarget, ownTrade), ownTrade)
      assert.equal(await resolverA.resolveId(tradeTarget, 'Own Trade'), ownTrade)

      const periodTarget = { resource: 'accounting-periods', by: 'name' }
      assert.equal(await resolverA.resolveId(periodTarget, victimPeriod.id), null)
      assert.equal(await resolverA.resolveId(periodTarget, ownPeriod.id), ownPeriod.id)

      // Sequence kinds are keys, never UUIDs; membership follows the drawer vocabulary.
      const kindTarget = { resource: 'number-sequence-kinds', by: 'code' }
      assert.equal(await resolverA.resolveId(kindTarget, 'vendor_bill'), 'vendor_bill')
      assert.equal(await resolverA.resolveId(kindTarget, randomUUID()), null)
      assert.equal(await resolverA.resolveId(kindTarget, 'no-such-kind'), null)
      assert.equal(await resolverA.resolveLabel(kindTarget, 'vendor_bill'), 'vendor_bill')

      // Global registered targets keep natural-key behavior (currencies are
      // shared), but a UUID must still name an existing row — never blind.
      const currencyTarget = { resource: 'currencies', by: 'code' }
      const cad = await resolverA.resolveId(currencyTarget, 'CAD')
      assert.equal(cad, 'CAD')
      assert.equal(await resolverA.resolveId(currencyTarget, 'ZZZ'), null)
      assert.equal(await resolverA.resolveId(currencyTarget, randomUUID()), null)
      assert.equal(await resolverA.resolveLabel(currencyTarget, 'CAD'), 'CAD')

      // Truly unknown targets fail closed instead of persisting blind — and
      // inherited Object keys must never reach dynamic SQL as a role table.
      const unknownTarget = { resource: 'no-such-resource', by: 'id' }
      assert.equal(await resolverA.resolveId(unknownTarget, randomUUID()), null)
      assert.equal(await resolverA.resolveId(unknownTarget, 'whatever'), null)
      const probe = randomUUID()
      assert.equal(await resolverA.resolveLabel(unknownTarget, probe), probe)
      for (const hostile of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
        assert.equal(await resolverA.resolveId({ resource: hostile, by: 'id' }, randomUUID()), null)
        assert.equal(await resolverA.resolveId({ resource: hostile, by: 'id' }, 'whatever'), null)
      }
    } finally {
      await dropScratchOrgReporting(orgA.orgId)
      await dropScratchOrgReporting(orgB.orgId)
    }
  },
)

/**
 * Master-data custom reference fields are schemaless jsonb: the shape check
 * never verified ownership, so a foreign project UUID persisted blind. They
 * now resolve through the same fence.
 */
test(
  'master custom references refuse foreign UUIDs',
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const orgA = await createScratchOrg()
    const orgB = await createScratchOrg()
    try {
      const victimProject = randomUUID()
      const ownProject = randomUUID()
      await db.execute(sql`insert into projects (id, org_id, name, code) values (${victimProject}, ${orgB.orgId}, 'Victim', 'VIC-P2')`)
      await db.execute(sql`insert into projects (id, org_id, name, code) values (${ownProject}, ${orgA.orgId}, 'Own', 'OWN-P2')`)
      const refKey = `ownerproj_${randomUUID().replaceAll('-', '').slice(0, 12)}`
      const actorA = randomUUID()
      await db.execute(sql`
        insert into custom_field_defs (org_id, target_table, key, label, field_type, config, is_required, sort_order, is_active)
        values (${orgA.orgId}, 'items', ${refKey}, 'Owner project', 'reference', '{"referenceTable":"projects"}'::jsonb, false, 0, true)`)
      const entity = MASTER_BY_KEY.get('items')
      assert.ok(entity)
      const resource = masterResource(entity, orgA.orgId)
      const code = `WIDG-${randomUUID().replaceAll('-', '').slice(0, 8)}`

      const refused = await resource.write(
        [{ code, name: 'Smuggled widget', kind: 'non_inventory', [refKey]: victimProject }],
        'insert',
        { orgId: orgA.orgId, actorId: actorA, dryRun: false },
      )
      assert.equal(refused.created, 0)
      assert.equal(refused.failed, 1)
      assert.match(refused.errors[0]?.message ?? '', /not found/)
      const stored = await db.execute<{ count: number }>(sql`
        select count(*)::int as count from items where org_id = ${orgA.orgId} and code = ${code}`)
      assert.equal(stored.rows[0]?.count, 0)

      const accepted = await resource.write(
        [{ code, name: 'Own widget', kind: 'non_inventory', [refKey]: 'OWN-P2' }],
        'insert',
        { orgId: orgA.orgId, actorId: actorA, dryRun: false },
      )
      assert.deepEqual(
        { created: accepted.created, failed: accepted.failed },
        { created: 1, failed: 0 },
      )
      const custom = (await db.execute<{ custom: { ownerproj?: string } & Record<string, unknown> }>(sql`
        select custom from items where org_id = ${orgA.orgId} and code = ${code}`)).rows[0]?.custom
      assert.equal(custom?.[refKey], ownProject)

      // Native clear semantics: a blank optional reference is omitted, never
      // a not-found failure — and the stored value is left alone, not wiped.
      const cleared = await resource.write(
        [{ code, name: 'Own widget', kind: 'non_inventory', [refKey]: '' }],
        'upsert',
        { orgId: orgA.orgId, actorId: actorA, dryRun: false },
      )
      assert.deepEqual(
        { created: cleared.created, updated: cleared.updated, failed: cleared.failed },
        { created: 0, updated: 1, failed: 0 },
      )
      const retained = (await db.execute<{ custom: Record<string, unknown> }>(sql`
        select custom from items where org_id = ${orgA.orgId} and code = ${code}`)).rows[0]?.custom
      assert.equal(retained?.[refKey], ownProject)
    } finally {
      await dropScratchOrgReporting(orgA.orgId)
      await dropScratchOrgReporting(orgB.orgId)
    }
  },
)

/**
 * Property `naturalId` used to return any UUID unchecked; a file naming
 * another tenant's subsidiary would attach the property to it. The writer
 * now verifies UUIDs against the owning org.
 */
test(
  'property imports refuse foreign subsidiary UUIDs',
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const orgA = await createScratchOrg()
    const orgB = await createScratchOrg()
    try {
      const actorA = randomUUID()
      const resource = propertyDataResource(orgA.orgId, 'properties')
      assert.ok(resource)
      const refused = await resource.write(
        [{ code: 'SMUGGLED', name: 'Smuggled', subsidiary: orgB.subsidiaryId, propertyType: 'residential' }],
        'insert',
        { orgId: orgA.orgId, actorId: actorA, dryRun: true },
      )
      assert.equal(refused.created, 0)
      assert.equal(refused.failed, 1)
      assert.match(refused.errors[0]?.message ?? '', /not found/)

      const ownSubsidiary = (await db.execute<{ name: string }>(sql`
        select name from subsidiaries where id = ${orgA.subsidiaryId}`)).rows[0]!.name
      const preview = await resource.write(
        [{ code: 'PREVIEW', name: 'Preview', subsidiary: ownSubsidiary, propertyType: 'residential' }],
        'insert',
        { orgId: orgA.orgId, actorId: actorA, dryRun: true },
      )
      assert.deepEqual(
        { created: preview.created, failed: preview.failed },
        { created: 1, failed: 0 },
      )
      const persisted = await db.execute<{ count: number }>(sql`
        select count(*)::int as count from managed_properties where org_id = ${orgA.orgId} and code = 'PREVIEW'`)
      assert.equal(persisted.rows[0]?.count, 0)
    } finally {
      await dropScratchOrgReporting(orgA.orgId)
      await dropScratchOrgReporting(orgB.orgId)
    }
  },
)

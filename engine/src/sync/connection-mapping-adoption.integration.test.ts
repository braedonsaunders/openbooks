import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { sql } from 'drizzle-orm';
import { db, withBypassContext, withMaintenanceTransaction } from '../platform/db.ts';
import { createScratchOrg, dropScratchOrg } from '../testing/fixtures.ts';
import { connectionSourceOptions, NETSUITE_MAPPING_GROUPS } from './connection-settings.ts';

const migration = readFileSync(new URL('../../../schema/migrations/generated/0788_connection_mapping_authority.sql', import.meta.url), 'utf8');
const rollback = new Error('Rollback private mapping migration proof');

test('connection mapping adoption preserves options, conflicts and unreadable evidence and replays without new writes', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    await assert.rejects(withMaintenanceTransaction(null, async () => {
      const options = { projectForemanField: 'custentity_foreman', timeTypeRecord: 'customrecord_time', timeTypeMultiplierField: 'custrecord_multiplier',
        projectStatuses: { Complete: 'closed' }, projectBillingTypes: { FBI: 'cost_plus' }, taxCodeFallbacks: { sales: '-8', purchase: '13.5' } };
      const retained = { nested: ['Original', false, null], amount: '100.0100' };
      const original = [
        { entityMappings: { version: 1, entities: {}, sourceOptions: options } },
        { mappingJson: options }, { mappingJson: JSON.stringify(options) },
        { mappingJson: { obsolete: retained, timeTypeMultiplierField: 'custrecord_multiplier' } },
        { mappingJson: '{unreadable' },
        { mappingJson: { projectForemanField: 'custentity_old' }, entityMappings: { version: 1, entities: {}, sourceOptions: { projectForemanField: 'custentity_new' } } },
        { mappingJson: { projectStatuses: { active: 'active', ACTIVE: 'closed' } } },
      ];
      const ids: string[] = [];
      for (const [i, config] of original.entries()) {
        const id = randomUUID(); ids.push(id);
        await db.execute(sql`insert into connections(id,org_id,source,display_name,config)
          values(${id},${org.orgId},'netsuite',${`Mapping adoption ${i}`},${JSON.stringify(config)}::jsonb)`);
      }
      const financial = async () => (await db.execute(sql`select id,status,total from documents where org_id=${org.orgId} order by id`)).rows;
      const before = await financial();
      // The entire published data change and every assertion are rolled back.
      await db.execute(sql.raw(migration));
      const rows = (await db.execute<{ id: string; config: Record<string, unknown> }>(sql`select id,config from connections where org_id=${org.orgId}`)).rows;
      const configs = ids.map(id => rows.find(row => row.id===id)!.config);
      assert.deepEqual(configs[0],original[0]);
      for (const index of [1,2]) {
        assert.equal(Object.hasOwn(configs[index]!, 'mappingJson'),false);
        assert.deepEqual(connectionSourceOptions(configs[index]!,NETSUITE_MAPPING_GROUPS),options);
      }
      const model = configs[3]!.entityMappings as { unavailableRules: { key: string; value: unknown }[] };
      assert.deepEqual(model.unavailableRules.find(rule=>rule.key==='obsolete')!.value,retained);
      assert.equal(model.unavailableRules.find(rule=>rule.key==='timeTypeMultiplierField')!.value,'custrecord_multiplier');
      const unreadable = configs[4]!.entityMappings as { unavailableRules: { value: unknown }[] };
      assert.equal(unreadable.unavailableRules[0]!.value,'{unreadable');
      const conflict = configs[5]!.entityMappings as { sourceOptions: Record<string, unknown>; unavailableRules: { value: unknown }[] };
      assert.equal(conflict.sourceOptions.projectForemanField,'custentity_new');
      assert.equal(conflict.unavailableRules[0]!.value,'custentity_old');
      for (const index of [3,4,5,6]) assert.throws(()=>connectionSourceOptions(configs[index]!,NETSUITE_MAPPING_GROUPS),/Remove or resolve/);
      const audit = async () => (await db.execute<{ changes: { before: { mappingSha256: string }; after: { entityMappingsSha256: string } } }>(sql`
        select changes from audit_log where org_id=${org.orgId} and table_name='connections' order by id`)).rows;
      const firstAudit = await audit();
      assert.equal(firstAudit.length,6);
      for (const row of firstAudit) {
        assert.match(row.changes.before.mappingSha256,/^[a-f0-9]{64}$/);
        assert.match(row.changes.after.entityMappingsSha256,/^[a-f0-9]{64}$/);
      }
      await db.execute(sql.raw(migration));
      assert.deepEqual(await audit(),firstAudit);
      assert.deepEqual(await financial(),before);
      throw rollback;
    }), error=>error===rollback);
  } finally { await withBypassContext(()=>dropScratchOrg(org.orgId)); }
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { db, withBypassContext, withOrgContext } from '@openbooks/engine/src/platform/db.ts';
import { createScratchOrg, createScratchUser, dropScratchOrg } from '@openbooks/engine/src/testing/fixtures.ts';
import { getConnection } from '@openbooks/engine/src/sync/connection.ts';
import { stubModules } from '../../../../../../testing/stub-modules';

const state = { orgId: '', userId: '', permission: '', denied: false, restricted: false };
Object.assign(globalThis, { __entityMappingCatalogAuth: state });
const responseModule = import.meta.resolve('next/server');
stubModules({ authz: { source: `
  import { NextResponse } from ${JSON.stringify(responseModule)};
  const state=globalThis.__entityMappingCatalogAuth;
  export async function guardPermission(permission) {
    state.permission=permission;
    return state.denied ? NextResponse.json({error:'forbidden'},{status:403}) : {user:{orgId:state.orgId,id:state.userId}};
  }
  export function guardUnrestrictedScope(){return state.restricted ? NextResponse.json({error:'restricted'},{status:403}) : null;}
` } });

test('mapping catalog and saved rules use native organization reads, permissions, typed references and audited connection writes', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg(), foreign = await createScratchOrg();
  try {
    state.orgId = org.orgId; state.userId = await createScratchUser(org.orgId, 'Connection mapping administrator', 'admin');
    const id = randomUUID(), foreignId = randomUUID();
    const config = { historyStartDate: org.date, baseCurrency: 'CAD', region: 'CA' };
    await withBypassContext(async () => {
      await db.execute(sql`insert into connections(id,org_id,source,display_name,config) values(${id},${org.orgId},'qbd','Desktop source',${JSON.stringify(config)}::jsonb),(${foreignId},${foreign.orgId},'qbd','Private source',${JSON.stringify(config)}::jsonb)`);
      await db.execute(sql`insert into custom_field_defs(org_id,target_table,key,label,field_type,config) values
        (${org.orgId},'items','owner','Owner','reference','{"referenceTable":"parties"}'::jsonb),
        (${foreign.orgId},'items','private_field','Private field','text','{}'::jsonb)`);
    });
    const { GET } = await import('./route');
    const { PATCH } = await import('../route');
    const call = (query = '', connectionId = id) => withOrgContext(org.orgId, () => GET(new Request(`http://localhost/api/platform/connections/${connectionId}/mapping-catalog?${query}`), { params: Promise.resolve({ id: connectionId }) }));
    const save = (entityMappings: unknown) => withOrgContext(org.orgId, () => PATCH(new Request(`http://localhost/api/platform/connections/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: { entityMappings } }) }), { params: Promise.resolve({ id }) }));
    state.denied = true; assert.equal((await call()).status, 403);
    state.denied = false; state.restricted = true; assert.equal((await call()).status, 403);
    state.restricted = false;
    assert.equal((await call('', foreignId)).status, 404);
    assert.equal((await call('', 'not-a-uuid')).status, 400);
    assert.equal((await call('target=custom.owner')).status, 422);
    assert.equal((await call('entity=projects')).status, 422, 'undeclared connector entities are refused');
    const catalog = await call(); assert.equal(catalog.status, 200);
    const entities = (await catalog.json()).entities as { key: string; nativeFields: { key: string }[] }[];
    assert.ok(['items', 'customers', 'vendors', 'employees', 'transactions', 'transactionLines'].every(key => entities.some(entity => entity.key === key)));
    const items = entities.find(entity => entity.key === 'items')!;
    assert.ok(items.nativeFields.some(field => field.key === 'custom.owner'));
    assert.ok(!items.nativeFields.some(field => field.key === 'custom.private_field'));
    const choices = await call('entity=items&target=custom.owner'); assert.equal(choices.status, 200);
    const options = (await choices.json()).options as { value: string }[];
    assert.ok(options.some(option => option.value === org.customerId));
    assert.ok(!options.some(option => option.value === foreign.customerId));
    const absent = await call('entity=items&target=custom.owner&q=no-such-reference');
    assert.equal(absent.status, 200); assert.deepEqual((await absent.json()).options, []);
    const retained = await call(`entity=items&target=custom.owner&q=no-such-reference&selected=${org.customerId}`);
    assert.deepEqual((await retained.json()).options.map((option: { value: string }) => option.value), [org.customerId], 'the selected native value reopens even outside the current search results');
    const isolated = await call(`entity=items&target=custom.owner&q=no-such-reference&selected=${foreign.customerId}`);
    assert.deepEqual((await isolated.json()).options, [], 'selected values cannot expose a foreign organization');
    assert.equal(state.permission, 'admin.setup.manage');
    const mappings = { version: 1, entities: { items: [{ source: 'name', target: 'custom.owner', missing: 'default', defaultValue: org.customerId, values: [{ source: 'A', target: org.customerId }] }] } };
    const saved = await save(mappings); assert.equal(saved.status, 200, JSON.stringify(await saved.json()));
    await withOrgContext(org.orgId, async () => {
      assert.deepEqual((await getConnection(org.orgId, id))!.config.entityMappings, mappings);
      const audit = (await db.execute<{ changes: Record<string, unknown> }>(sql`select changes from audit_log where org_id=${org.orgId} and table_name='connections' and row_id=${id} and actor_id=${state.userId}`)).rows;
      assert.equal(audit.length, 1);
    });
    assert.equal((await save({ version: 1, entities: { items: [{ target: 'custom.owner', missing: 'default', defaultValue: foreign.customerId }] } })).status, 422);
    assert.equal((await save({ version: 1, entities: {}, unavailableRules: [{ key: 'unsupported', value: { nested: ['Original'] }, reason: 'Unsupported saved rule' }] })).status, 400);
    assert.equal((await save({ version: 1, entities: { items: [{ source: 'unknown', target: 'name', missing: 'refuse' }] } })).status, 422);
    assert.equal((await save({ version: 1, entities: { items: [{ target: 'custom.private_field', missing: 'default', defaultValue: 'Private' }] } })).status, 422);
    await withOrgContext(org.orgId, async () => assert.deepEqual((await getConnection(org.orgId, id))!.config.entityMappings, mappings, 'refused writes preserve all saved rules'));
  } finally { state.denied = false; state.restricted = false; await dropScratchOrg(foreign.orgId); await dropScratchOrg(org.orgId); }
});

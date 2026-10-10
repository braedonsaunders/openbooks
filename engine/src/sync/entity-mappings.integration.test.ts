import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { sql } from 'drizzle-orm';
import { db, withBypassContext, withOrgContext } from '../platform/db.ts';
import { createScratchOrg, createScratchUser, dropScratchOrg } from '../testing/fixtures.ts';
import { entityMappingMetadata } from './entity-mapping-contract.ts';
import { connectionEntityMappingMetadata, validateConnectionEntityMappings, withEntityMappings } from './entity-mappings.ts';
import { loadEntities } from './migrate.ts';
import { runSync } from './sync.ts';
import type { MigrationSource } from './source.ts';
import type { NativeDocument } from './native.ts';

test('connection entity mappings use native custom definitions, persist across replay, audit changes and refuse foreign references before import', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg(), foreign = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, 'Mapping administrator', 'mapping_admin');
    const connectionId = randomUUID();
    await withBypassContext(async () => {
      await db.execute(sql`insert into connections(id,org_id,source,display_name) values(${connectionId},${org.orgId},'qbo','Mapped source')`);
      await db.execute(sql`insert into custom_field_defs(org_id,target_table,key,label,field_type,config) values
        (${org.orgId},'items','classification','Classification','select',${JSON.stringify({ options: ['Materials', 'Services'] })}::jsonb),
        (${foreign.orgId},'items','private_classification','Private classification','text','{}'::jsonb),
        (${org.orgId},'items','owner','Owner','reference',${JSON.stringify({ referenceTable: 'parties' })}::jsonb)`);
    });
    const foreignParty = (await withBypassContext(() => db.execute<{ id: string }>(sql`insert into parties(org_id,kind,display_name) values(${foreign.orgId},'person','Foreign owner') returning id`))).rows[0]!.id;
    let category = 'stock';
    const raw: MigrationSource = {
      name: 'qbo', refKey: 'qboId', baseCurrency: 'CAD', entityMappingMetadata: entityMappingMetadata(['items'], []),
      accountingPeriods: async () => [],
      entities: async () => [{ resource: 'items', records: [{ sourceRef: 'item-100', fields: { code: 'M-100', name: 'Original name', kind: 'service', isActive: true } }] }],
      mappingSourceFields: async () => [{ key: 'source_class', label: 'Source class', kind: 'text' }],
      mappingSourceValues: async (_entity, fields, refs) => {
        assert.deepEqual(fields, ['source_class']); assert.deepEqual(refs, ['item-100']);
        return new Map([['item-100', { source_class: category }]]);
      },
      nativeChanges: async () => { throw new Error('No transaction pull in this entity control'); }, trialBalance: async () => [], monthlyActivity: async () => [],
    };
    const mappings = { version: 1, entities: { items: [
      { target: 'name', missing: 'default', defaultValue: 'Mapped name' },
      { source: 'source_class', target: 'custom.classification', missing: 'default', defaultValue: 'Services', values: [{ source: 'stock', target: 'Materials' }] },
    ] } };
    await withOrgContext(org.orgId, async () => {
      const metadata = await connectionEntityMappingMetadata(raw, org.orgId);
      assert.ok(metadata[0]!.nativeFields.some(field => field.key === 'custom.classification'));
      assert.ok(!metadata[0]!.nativeFields.some(field => field.key === 'custom.private_classification'));
      await validateConnectionEntityMappings(raw, org.orgId, mappings);
      const source = withEntityMappings(raw, mappings, org.orgId);
      const audit = { connectionId, actorId, runId: randomUUID(), sourceName: 'qbo' };
      const first = await loadEntities(source, org.orgId, null, undefined, audit);
      assert.equal(first.items!.created, 1); assert.equal(first.items!.failed, 0);
      const read = () => db.execute<{ id: string; name: string; custom: Record<string, unknown> }>(sql`select id,name,custom from items where org_id=${org.orgId} and custom->>'qboId'='item-100'`);
      const saved = (await read()).rows[0]!;
      assert.equal(saved.name, 'Mapped name'); assert.equal(saved.custom.classification, 'Materials');
      await loadEntities(source, org.orgId, new Date('2026-01-01'), undefined, audit);
      assert.equal((await read()).rows[0]!.id, saved.id, 'mirror replay retains native identity');
      const count = () => db.execute<{ count: number }>(sql`select count(*)::int as count from audit_log where org_id=${org.orgId} and table_name='items' and actor_id=${actorId}`);
      assert.equal((await count()).rows[0]!.count, 1, 'unchanged replay adds no audit event');
      category = 'nonstock';
      await loadEntities(source, org.orgId, new Date('2026-01-02'), undefined, audit);
      assert.equal((await read()).rows[0]!.custom.classification, 'Services'); assert.equal((await count()).rows[0]!.count, 2);
      await assert.rejects(validateConnectionEntityMappings(raw, org.orgId, { version: 1, entities: { items: [{ target: 'custom.owner', missing: 'default', defaultValue: foreignParty }] } }), /in this organization/);
      await assert.rejects(validateConnectionEntityMappings(raw, org.orgId, { version: 1, entities: { items: [{ target: 'custom.classification', missing: 'default', defaultValue: 'Unsupported' }] } }), /supported value/);
      const refused = withEntityMappings(raw, { version: 1, entities: { items: [{ source: 'source_class', target: 'category', missing: 'refuse', values: [{ source: 'stock', target: 'Materials' }] }] } }, org.orgId);
      await assert.rejects(loadEntities(refused, org.orgId, null, undefined, audit), /no value mapping/);
      assert.equal((await read()).rows[0]!.custom.classification, 'Services', 'refusal preserves the last native projection');
    });
  } finally { await dropScratchOrg(foreign.orgId); await dropScratchOrg(org.orgId); }
});

test('transaction and line custom mappings persist through the native writer and compare unchanged on mirror replay', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const connectionId = randomUUID();
    await withBypassContext(async () => {
      await db.execute(sql`insert into connections(id,org_id,source,display_name) values(${connectionId},${org.orgId},'qbo','Mapped documents')`);
      await db.execute(sql`insert into custom_field_defs(org_id,target_table,key,label,field_type) values(${org.orgId},'documents','evidence','Evidence','text'),(${org.orgId},'document_lines','classification','Classification','text')`);
    });
    const doc: NativeDocument = { sourceRef: 'order-100', kind: 'sales_order', posting: false, lifecycleStatus: 'approved', partyId: org.customerId,
      subsidiaryId: org.subsidiaryId, currency: 'CAD', fxRate: '1', documentDate: org.date, dueDate: org.date, memo: 'Original memo', referenceNumber: null, controlAccountId: null, subtotal: '100', total: '100',
      lines: [{ lineNumber: 1, sourceLineRef: 'line-1', accountId: org.accounts.revenue, itemId: null, amount: '100', taxAmount: '0', taxOverridden: false, taxCodeId: null, departmentId: null, projectId: null, description: 'Original description' }] };
    const source: MigrationSource = { name: 'qbo', refKey: 'qboId', baseCurrency: 'CAD', entityMappingMetadata: entityMappingMetadata([]), accountingPeriods: async () => [], entities: async () => [],
      nativeChanges: async () => ({ documents: [structuredClone(doc)], applications: [], deletedRefs: [], syncedThrough: new Date('2026-07-20T00:00:00Z'), unbuildable: [] }), trialBalance: async () => [], monthlyActivity: async () => [], openItems: async () => [] };
    const mappings = (evidence: string) => ({ version: 1, entities: { transactions: [{ target: 'custom.evidence', missing: 'default', defaultValue: evidence }], transactionLines: [{ source: 'description', target: 'custom.classification', missing: 'refuse' }] } });
    await withOrgContext(org.orgId, async () => {
      const options = { orgId: org.orgId, connectionId, kind: 'full_migration' as const, since: null };
      const configured = withEntityMappings(source, mappings('First'), org.orgId);
      const first = await runSync(configured, 'mapping-control', options);
      assert.equal(first.ordersNew, 1); assert.equal(first.docsFailed, 0);
      const saved = (await db.execute<{ id: string; custom: Record<string, unknown> }>(sql`select id,custom from documents where org_id=${org.orgId} and custom->>'qboId'='order-100'`)).rows[0]!;
      assert.equal(saved.custom.evidence, 'First');
      const line = (await db.execute<{ custom: Record<string, unknown> }>(sql`select custom from document_lines where org_id=${org.orgId} and document_id=${saved.id}`)).rows[0]!;
      assert.equal(line.custom.classification, 'Original description');
      const replay = await runSync(configured, 'mapping-control', { ...options, kind: 'incremental', since: new Date('2026-07-19T00:00:00Z') });
      assert.equal(replay.docsUnchanged, 1); assert.equal(replay.docsFailed, 0);
      await db.execute(sql`update document_lines set custom=custom||'{"classification":"Operator edit"}'::jsonb where org_id=${org.orgId} and document_id=${saved.id}`);
      const reapplied = await runSync(configured, 'mapping-control', options);
      assert.equal(reapplied.docsAmended, 1, 'replay compares actual native mapped values, not a stale ownership marker');
      assert.equal((await db.execute<{ custom: Record<string, unknown> }>(sql`select custom from document_lines where org_id=${org.orgId} and document_id=${saved.id}`)).rows[0]!.custom.classification, 'Original description');
      const changed = await runSync(withEntityMappings(source, mappings('Second'), org.orgId), 'mapping-control', options);
      assert.equal(changed.docsAmended, 1); assert.equal(changed.docsFailed, 0);
      const after = (await db.execute<{ id: string; custom: Record<string, unknown> }>(sql`select id,custom from documents where org_id=${org.orgId} and custom->>'qboId'='order-100'`)).rows[0]!;
      assert.equal(after.id, saved.id); assert.equal(after.custom.evidence, 'Second');
    });
  } finally { await dropScratchOrg(org.orgId); }
});

test('conflicting customer and vendor rules refuse shared identities instead of depending on role order', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const source: MigrationSource = {
      name: 'xero', refKey: 'xeroId', baseCurrency: 'CAD', entityMappingMetadata: entityMappingMetadata(['parties'], ['customers', 'vendors']),
      accountingPeriods: async () => [], entities: async () => [{ resource: 'parties', records: [{ sourceRef: 'shared', mappingEntities: ['customers', 'vendors'], fields: { displayName: 'Shared contact', kind: 'company', isActive: true } }] }],
      nativeChanges: async () => { throw new Error('No transaction pull in this entity control'); }, trialBalance: async () => [], monthlyActivity: async () => [],
    };
    await withOrgContext(org.orgId, async () => {
      const configured = withEntityMappings(source, { version: 1, entities: {
        customers: [{ target: 'displayName', missing: 'default', defaultValue: 'Customer name' }],
        vendors: [{ target: 'displayName', missing: 'default', defaultValue: 'Vendor name' }],
      } }, org.orgId);
      await assert.rejects(configured.entities!(), /Role mappings conflict/);
    });
  } finally { await dropScratchOrg(org.orgId); }
});

test('operational mappings preserve native lifecycle and money while applying saved fields, custom values and replay audits', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const { sealJson } = await import('../platform/secrets.ts');
    const { importNetSuiteCrm } = await import('./netsuite-crm.ts');
    const connectionId = randomUUID(), actorId = await createScratchUser(org.orgId, 'CRM mapping administrator', 'admin');
    const mappings = { version: 1, entities: {
      crmAccountStatuses: [{ target: 'name', missing: 'default', defaultValue: 'Source customer status' }],
      crmAccounts: [{ source: 'lifecycleStage', target: 'custom.classification', missing: 'refuse', values: [{ source: 'customer', target: 'Established' }] }],
      crmOpportunities: [{ target: 'title', missing: 'default', defaultValue: 'Mapped opportunity' }],
      crmActivities: [{ source: 'subject', target: 'custom.topic', missing: 'refuse' }, { target: 'subject', missing: 'default', defaultValue: 'Mapped source activity' }],
    } };
    await withBypassContext(async () => {
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"crm":true}'::jsonb) where id=${org.orgId}`);
      await db.execute(sql`update parties set custom=custom||'{"nsId":"100"}'::jsonb where org_id=${org.orgId} and id=${org.customerId}`);
      await db.execute(sql`insert into custom_field_defs(org_id,target_table,key,label,field_type,config) values
        (${org.orgId},'crm_account_profiles','classification','Classification','select','{"options":["Established"]}'::jsonb),
        (${org.orgId},'crm_activities','topic','Topic','text','{}'::jsonb)`);
      await db.execute(sql`insert into connections(id,org_id,source,display_name,config,secrets) values(${connectionId},${org.orgId},'netsuite','Mapped CRM',${JSON.stringify({ account: '123456', host: 'https://123456.suitetalk.api.netsuite.com', baseCurrency: 'CAD', entityMappings: mappings })}::jsonb,${sealJson({ consumerKey: 'ck', consumerSecret: 'cs', tokenKey: 'tk', tokenSecret: 'ts' }, { orgId: org.orgId, purpose: 'connection.secrets' })})`);
    });
    const transport: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('/query/v1/suiteql')) {
        const q = String(JSON.parse(String(init?.body)).q);
        const items = q.includes('from entitystatus') ? [{ key: '17', name: 'Customer', entitytype: 'CUSTOMER' }]
          : q.includes('from customer') ? [{ id: '100', stage: 'customer', entitystatus: '17', datecreated: org.date }]
          : q.includes("from transaction where type='Opprtnty'") ? [{ id: '200', tranid: 'OPP-200', entity: '100', currency: 'CAD', probability: '50', foreigntotal: '100.01', memo: 'Source title' }]
          : q.includes('from recentactivity') ? [{ id: '300', entity: '100', type: 'Note : 9', typecode: 'Note : 9', createddate: org.date, details: 'Source site visit', subdetails: 'Source note' }]
          : [];
        return Response.json({ items, hasMore: false });
      }
      if (url.includes('/record/v1/')) return Response.json({ items: [], hasMore: false });
      throw new Error('An unexpected external CRM read was requested');
    };
    await withOrgContext(org.orgId, async () => {
      const first = await importNetSuiteCrm(org.orgId, connectionId, transport, { actorId });
      assert.equal(first.accounts, 1); assert.equal(first.opportunities, 1); assert.equal(first.activities.recentActivityNote, 1);
      const profile = (await db.execute<{ lifecycle_stage: string; custom: Record<string, unknown> }>(sql`select lifecycle_stage,custom from crm_account_profiles where org_id=${org.orgId} and party_id=${org.customerId}`)).rows[0]!;
      assert.equal(profile.lifecycle_stage, 'customer'); assert.equal(profile.custom.classification, 'Established');
      const opportunity = (await db.execute<{ title: string; projected_amount: string; weighted_amount: string }>(sql`select title,projected_amount,weighted_amount from crm_opportunities where org_id=${org.orgId} and opportunity_number='OPP-200'`)).rows[0]!;
      assert.equal(opportunity.title, 'Mapped opportunity'); assert.equal(opportunity.projected_amount, '100.0100'); assert.equal(opportunity.weighted_amount, '50.0050');
      const activity = (await db.execute<{ subject: string; custom: Record<string, unknown> }>(sql`select subject,custom from crm_activities where org_id=${org.orgId} and custom->'netsuite'->>'id'='300'`)).rows[0]!;
      assert.equal(activity.subject, 'Mapped source activity'); assert.equal(activity.custom.topic, 'Source site visit', 'custom mapping reads the source before the subject override');
      const count = async () => (await db.execute<{ count: number }>(sql`select count(*)::int as count from audit_log where org_id=${org.orgId} and changes->>'event'='connector_entity_mapping_applied'`)).rows[0]!.count;
      assert.equal(await count(), 4);
      await importNetSuiteCrm(org.orgId, connectionId, transport, { actorId });
      assert.equal(await count(), 4, 'unchanged operational replay retains stable source identity without duplicate mapping audit');
    });
  } finally { await dropScratchOrg(org.orgId); }
});

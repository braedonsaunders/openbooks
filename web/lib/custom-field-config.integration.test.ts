import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { SessionUser } from './auth';
const root = pathToFileURL(process.cwd() + '/').href;
const state: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __customFieldConfig: state });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier === './auth' && context.parentURL?.endsWith('/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__customFieldConfig.user}' };
  if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context);
  return next(specifier, context);
} });
const { sql } = await import('drizzle-orm');
const { db, withOrgContext } = await import('@openbooks/engine/src/db.ts');
const { createScratchOrg, seedFlowActors, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts');
const { POST, PATCH } = await import('../app/api/admin/custom-fields/route');

const invalid: [string, Record<string, unknown>][] = [
  ['array display mode', { config: { displayMode: ['readonly'] } }],
  ['array reference target', { fieldType: 'reference', config: { referenceTable: ['parties'] } }],
  ['string active', { isActive: 'false' }], ['null sort', { sortOrder: null }],
  ['string list flag', { config: { showInList: 'false' } }],
  ['duplicate options', { fieldType: 'select', config: { options: ['One','One'] } }],
  ['blank options', { fieldType: 'select', config: { options: ['   '] } }],
  ['boolean label', { label: true }], ['object label', { label: { name: 'Wrong' } }], ['blank label', { label: '   ' }],
  ['array config', { config: [] }], ['scalar config', { config: 'invalid' }],
  ['string required', { isRequired: 'false' }], ['numeric required', { isRequired: 1 }],
  ['fractional sort', { sortOrder: 1.5 }], ['boolean sort', { sortOrder: true }], ['out-of-range sort', { sortOrder: 2147483648 }],
  ['malformed minimum', { config: { min: 'wrong' } }], ['array minimum', { config: { min: ['1'] } }], ['boolean maximum', { config: { max: true } }],
  ['reversed bounds', { config: { min: '100.0001', max: '100.0000' } }],
  ['overprecise bound', { config: { min: '0.00001' } }],
  ['default outside bounds', { config: { min: '2.0001', defaultValue: '2.0000' } }],
  ['malformed numeric default', { config: { defaultValue: 'wrong' } }],
  ['array numeric default', { config: { defaultValue: ['12'] } }],
  ['invalid date default', { fieldType: 'date', config: { defaultValue: '2026-02-30' } }],
  ['invalid boolean default', { fieldType: 'boolean', config: { defaultValue: 'sometimes' } }],
  ['invalid select default', { fieldType: 'select', config: { options: ['One'], defaultValue: 'Two' } }],
  ['invalid multi-select default', { fieldType: 'multi_select', config: { options: ['One'], defaultValue: ['One','Two'] } }],
  ['invalid reference default', { fieldType: 'reference', config: { referenceTable: 'parties', defaultValue: 'not-a-uuid' } }],
  ['invalid display mode', { config: { displayMode: 'almost-hidden' } }],
  ['invalid role list', { config: { allowedRoles: 'admin' } }],
  ['invalid help text', { config: { helpText: { text: 'Wrong' } } }],
];
for (const method of ['POST','PATCH'] as const) for (const [scenario, body] of invalid) {
  test(`custom-field definition ${method} rejects ${scenario}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      state.user = { id: actor, orgId: org.orgId, homeUserId: actor, homeOrgId: org.orgId, productionOrgId: org.orgId, envKind: 'production', name: 'Config reviewer', email: 'config@scratch.test', roles: [], isSuperAdmin: false };
      await db.execute(sql`update app_roles set permissions='["admin.custom_fields.manage"]'::jsonb where org_id=${org.orgId} and key='admin'`);
      const request = (verb: string, data: unknown) => new Request('http://audit.local/api/admin/custom-fields', { method: verb, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      const base = { targetTable: 'parties', key: 'review_limit', label: 'Review limit', fieldType: 'currency', config: {} };
      let revision: Record<string, unknown> = {};
      if (method === 'PATCH') {
        const created = await withOrgContext(org.orgId, () => POST(request('POST', base)));
        assert.equal(created.status, 200);
        const data = await created.json(); revision = { id: data.id, expectedUpdatedAt: data.updatedAt };
      }
      const snapshot = async () => (await db.execute(sql`select
        (select jsonb_agg(to_jsonb(f) order by f.id) from custom_field_defs f where org_id=${org.orgId}) as definitions,
        (select jsonb_agg(to_jsonb(a) order by a.id) from audit_log a where org_id=${org.orgId}) as audit`)).rows;
      const before = await snapshot();
      const response = await withOrgContext(org.orgId, () => (method === 'POST' ? POST : PATCH)(request(method, { ...base, ...revision, ...body })));
      assert.equal(response.status, 400, JSON.stringify(await response.json()));
      assert.deepEqual(await snapshot(), before, 'invalid definition must not change data or audit history');
    } finally { state.user = null; await dropScratchOrg(org.orgId); }
  });
}

const valid: [string, string, Record<string, unknown>, Record<string, unknown>][] = [
  ['exact currency', 'currency', { min: '900000000000000.1234', max: '900000000000000.1235', defaultValue: '900000000000000.1234' }, { min: '900000000000000.1234', max: '900000000000000.1235', defaultValue: '900000000000000.1234' }],
  ['canonical bounds', 'number', { min: ' +0002.1000 ', max: '0003.0000', defaultValue: '2.1000' }, { min: '2.1', max: '3', defaultValue: '2.1000' }],
  ['zero default', 'number', { min: 0, max: 100, defaultValue: 0 }, { min: '0', max: '100', defaultValue: 0 }],
  ['false default', 'boolean', { defaultValue: false }, { defaultValue: false }],
  ['leap date', 'date', { defaultValue: '2024-02-29' }, { defaultValue: '2024-02-29' }],
  ['single selection', 'select', { options: ['One','Two'], defaultValue: 'Two' }, { options: ['One','Two'], defaultValue: 'Two' }],
  ['multiple selections', 'multi_select', { options: ['One','Two'], defaultValue: ['One','Two'] }, { options: ['One','Two'], defaultValue: ['One','Two'] }],
  ['reference metadata', 'reference', { referenceTable: 'parties', referenceFilter: { kind: 'person' }, extension: { keep: true } }, { referenceTable: 'parties', referenceFilter: { kind: 'person' }, extension: { keep: true } }],
];
for (const [scenario, fieldType, config, expected] of valid) {
  test(`custom-field definition preserves ${scenario} across creation and label-only edits`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      state.user = { id: actor, orgId: org.orgId, homeUserId: actor, homeOrgId: org.orgId, productionOrgId: org.orgId, envKind: 'production', name: 'Config reviewer', email: 'config@scratch.test', roles: [], isSuperAdmin: false };
      await db.execute(sql`update app_roles set permissions='["admin.custom_fields.manage"]'::jsonb where org_id=${org.orgId} and key='admin'`);
      const request = (verb: string, data: unknown) => new Request('http://audit.local/api/admin/custom-fields', { method: verb, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      const create = await withOrgContext(org.orgId, () => POST(request('POST', { targetTable: 'parties', key: 'valid_review', label: 'Valid review', fieldType, config })));
      const created = await create.json(); assert.equal(create.status, 200, JSON.stringify(created));
      const row = async () => (await db.execute<{ config: unknown; label: string }>(sql`select config,label from custom_field_defs where org_id=${org.orgId} and id=${created.id}`)).rows[0]!;
      assert.deepEqual((await row()).config, expected);
      const edit = await withOrgContext(org.orgId, () => PATCH(request('PATCH', { id: created.id, expectedUpdatedAt: created.updatedAt, label: 'Renamed review' })));
      assert.equal(edit.status, 200, JSON.stringify(await edit.json()));
      assert.deepEqual(await row(), { config: expected, label: 'Renamed review' });
    } finally { state.user = null; await dropScratchOrg(org.orgId); }
  });
}

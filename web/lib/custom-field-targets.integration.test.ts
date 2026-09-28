import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import type { SessionUser } from './auth';
const state: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __customFieldTargets: state });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === './auth' && context.parentURL?.endsWith('/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__customFieldTargets.user}' };
  return next(specifier, context);
} });
const { sql } = await import('drizzle-orm');
const { db, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts');
const { createScratchOrg, seedFlowActors, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts');
const { POST } = await import('../app/api/admin/custom-fields/route');
const { FEATURES } = await import('./features');
const { loadFieldDefs } = await import('./custom-fields');
const { disabledCustomFieldTargets } = await import('./customization/gates');

const targets = [
  ['fixed_assets', null], ['time_entries', null],
  ['grants', null], ['encumbrances', null],
  ['parties', null], ['projects', null], ['managed_properties', null], ['item_rate_versions', null],
  ...['deposit', 'transfer', 'project_charge', 'quote', 'sales_order', 'purchase_order', 'field_ticket'].map(kind => ['documents', kind]),
  ...['deposit', 'project_charge', 'quote', 'sales_order', 'purchase_order', 'field_ticket'].map(kind => ['document_lines', kind]),
];
for (const [targetTable, targetKind] of targets) {
  test(`custom-field target persists and loads: ${targetTable}:${targetKind ?? 'all'}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      state.user = { id: actor, orgId: org.orgId, homeUserId: actor, homeOrgId: org.orgId, productionOrgId: org.orgId, envKind: 'production', name: 'Target reviewer', email: 'target@scratch.test', roles: [], isSuperAdmin: false };
      assert.equal((await db.execute(sql`update app_roles set permissions='["admin.custom_fields.manage"]'::jsonb where org_id=${org.orgId} and key='admin' returning key`)).rows.length, 1, `${targetTable}:${targetKind ?? 'all'} role setup`);
      assert.equal((await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',${JSON.stringify(Object.fromEntries(FEATURES.map(feature => [feature.key, true])))}::jsonb) where id=${org.orgId} returning id`)).rows.length, 1, `${targetTable}:${targetKind ?? 'all'} feature setup`);
      const response = await withOrgContext(org.orgId, () => POST(new Request('http://audit.local/api/admin/custom-fields', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetTable, targetKind, key: 'review_note', label: 'Review note', fieldType: 'text' }) })));
      if (!response.ok || response.status !== 200) throw new Error(await response.text());
      const created = await response.json();
      const loaded = await withOrgContext(org.orgId, () => loadFieldDefs(targetTable!, targetKind ?? undefined));
      // Owner-role focused runs may see other disposable tenants; the browser
      // journey separately exercises this reader under the runtime RLS role.
      const defs = loaded.filter(def => def.id === created.id);
      assert.equal(defs.length, 1); assert.equal(defs[0]!.key, 'review_note'); assert.equal(defs[0]!.targetTable, targetTable); assert.equal(defs[0]!.targetKind, targetKind);
    } finally { state.user = null; await dropScratchOrg(org.orgId); }
  });
}
for (const [table, feature, enabled] of [
  ['fixed_assets','fixedAssets', {}],
  ['time_entries','timeTracking', {}],
  ['grants','grantManagement', { nonprofit: true, fundAccounting: true }],
  ['grants','nonprofit', { grantManagement: true, fundAccounting: true }],
  ['encumbrances','encumbrances', { nonprofit: true, budgets: true }],
  ['encumbrances','nonprofit', { encumbrances: true, budgets: true }],
] as const) {
  test(`disabled custom-field target is hidden and refuses creation: ${table}:${feature}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      state.user = { id: actor, orgId: org.orgId, homeUserId: actor, homeOrgId: org.orgId, productionOrgId: org.orgId, envKind: 'production', name: 'Target reviewer', email: 'target@scratch.test', roles: [], isSuperAdmin: false };
      assert.equal((await db.execute(sql`update app_roles set permissions='["admin.custom_fields.manage"]'::jsonb where org_id=${org.orgId} and key='admin' returning key`)).rows.length, 1, `${table}:${feature} role setup`);
      assert.equal((await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',${JSON.stringify({ ...enabled, [feature]: false })}::jsonb) where id=${org.orgId} returning id`)).rows.length, 1, `${table}:${feature} feature setup`);
      await db.execute(sql`insert into custom_field_defs(org_id,target_table,key,label,field_type) values (${org.orgId},${table},'historical_note','Historical note','text')`);
      const hidden = await withOrgContext(org.orgId, () => disabledCustomFieldTargets(org.orgId));
      assert.ok(hidden.tables.includes(table), 'settings hide the disabled target');
      const response = await withOrgContext(org.orgId, () => POST(new Request('http://audit.local/api/admin/custom-fields', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetTable: table, key: 'review_note', label: 'Review note', fieldType: 'text' }) })));
      assert.equal(response.status, 404);
      const rows = (await db.execute(sql`select key from custom_field_defs where org_id=${org.orgId} and target_table=${table}`)).rows;
      assert.deepEqual(rows, [{ key: 'historical_note' }], 'disabled feature preserves historical definitions');
    } finally { state.user = null; await dropScratchOrg(org.orgId); }
  });
}

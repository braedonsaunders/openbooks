import assert from 'node:assert/strict';
import test from 'node:test';
import { NextResponse } from 'next/server';
import { stubModules } from '../../../../../../testing/stub-modules';
const state = { reads: [] as string[], fields: [] as string[], permission: '', refusal: '', exists: true, denial: null as NextResponse | null, restricted: false };
Object.assign(globalThis, { __mappingOptionsRoute: state });
stubModules({ authz: { source: `
  const state = globalThis.__mappingOptionsRoute;
  export async function guardPermission(permission) { state.permission = permission; return state.denial ?? { user: { orgId: 'org-1', id: 'user-1' } }; }
  export function guardUnrestrictedScope() { return state.restricted ? new Response('restricted', { status: 403 }) : null; }
` }, extra: {
  '@openbooks/engine/src/sync/connection.ts': `
    const state = globalThis.__mappingOptionsRoute;
    export async function getConnection(org, id) { state.reads.push(org + ':' + id); return state.exists ? { source: 'netsuite', config: {} } : null; }
    export function buildSource() { return { mappingOptions: async (field, parent) => {
      state.fields.push(field + ':' + (parent ?? '')); if (state.refusal) throw new Error(state.refusal);
      return [{ value: 'custrecord_multiplier', label: 'Multiplier' }];
    } }; }
  `,
} });
const { GET } = await import('./route');
const id = '00000000-0000-4000-8000-000000000002';
const call = (query: string) => GET(new Request(`http://localhost/api/platform/connections/${id}/mapping-options?${query}`), { params: Promise.resolve({ id }) });
test('mapping discovery requires setup permission and full entity scope, and binds metadata to the native organization and selected parent', async () => {
  state.denial = NextResponse.json({ error: 'forbidden' }, { status: 403 });
  assert.equal((await call('field=timeTypeRecord')).status, 403); assert.equal(state.reads.length, 0);
  state.denial = null; state.restricted = true;
  assert.equal((await call('field=timeTypeRecord')).status, 403); assert.equal(state.reads.length, 0);
  state.restricted = false;
  assert.equal((await call('field=timeTypeMultiplierField')).status, 422); assert.equal(state.fields.length, 0);
  assert.equal((await call('field=unknown')).status, 422); assert.equal(state.fields.length, 0);
  const response = await call('field=timeTypeMultiplierField&parent=customrecord_time');
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), [{ value: 'custrecord_multiplier', label: 'Multiplier' }]);
  assert.equal(state.permission, 'admin.setup.manage'); assert.ok(state.reads.every((read) => read === `org-1:${id}`));
  assert.deepEqual(state.fields, ['timeTypeMultiplierField:customrecord_time']);
  state.refusal = 'Grant custom-record read access and retry';
  const denied = await call('field=timeTypeRecord'); assert.equal(denied.status, 422); assert.match((await denied.json()).error, /Grant custom-record read access/);
  state.exists = false; assert.equal((await call('field=timeTypeRecord')).status, 404);
});

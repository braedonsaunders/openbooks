import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { resolveAppModule } from "../test-module-hooks";
import type { readEntityListPage } from "../list/entity-reader";

const root = pathToFileURL(process.cwd() + '/').href;
const actorId = '00000000-0000-4000-8000-000000000001';
const orgId = '00000000-0000-4000-8000-000000000002';
const scope = new Set(['00000000-0000-4000-8000-000000000003']);
const state = { reads: [] as Parameters<typeof readEntityListPage>[0][], actorId, orgId, scope };
Object.assign(globalThis, { __assignmentResourceBoundary: state });
registerHooks({
  resolve(s, c, next) {
    const wrap = (path: string, source: string) => ({ shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(`export * from ${JSON.stringify(root + path)};${source}`) });
    if (s === './resource-core') return wrap('web/lib/data-io/resource-core.ts', 'export async function orgFeatureEnabled(){return true}');
    if (s === '../custom-fields' && c.parentURL?.endsWith('/resourcing-resources.ts')) return wrap('web/lib/custom-fields.ts', 'export async function loadFieldDefs(){return []}');
    if (s === '@openbooks/engine/src/platform/db.ts' && c.parentURL?.endsWith('/resourcing-resources.ts')) return wrap('engine/src/platform/db.ts', 'export async function withOrgTransaction(orgId,fn){return fn()}');
    if (s === '../list/entity-reader' && c.parentURL?.endsWith('/resourcing-resources.ts')) return wrap('web/lib/list/entity-reader.ts', `export async function readEntityListPage(input){globalThis.__assignmentResourceBoundary.reads.push(input);return {ok:false,error:'scope_required',remedy:'Pass the acting user and explicit subsidiary scope'}}`);
    if (s === '@/lib/authz') return wrap('web/lib/authz.ts', `export async function guardPermission(){const s=globalThis.__assignmentResourceBoundary;return {user:{id:s.actorId,orgId:s.orgId},permissions:new Set(['data.export','resourcing.read']),allowedSubsidiaryIds:s.scope}}`);
    return resolveAppModule(s, c, next, root) ?? next(s, c);
  },
});

const m = await import("./resourcing-resources.ts");
const { RefResolver } = await import('./resource-core.ts');
const { POST } = await import('../../app/api/data/export/route.ts');

test("assignment plan imports and exports under the resourcing grants", () => {
  assert.equal(m.ASSIGNMENTS_DESCRIPTOR.key, "resourcing-assignments");
  assert.equal(m.ASSIGNMENTS_DESCRIPTOR.supportsImport, true);
  assert.equal(m.ASSIGNMENTS_DESCRIPTOR.readPermission, "resourcing.read");
  assert.equal(m.ASSIGNMENTS_DESCRIPTOR.writePermission, "resourcing.manage");
  assert.equal(m.ASSIGNMENTS_DESCRIPTOR.scopedWrite, true);
});

test("retainer balances are export-only, per-currency, with no import surface", () => {
  assert.equal(m.RETAINER_BALANCES_DESCRIPTOR.supportsImport, false);
  assert.equal(m.RETAINER_BALANCES_DESCRIPTOR.readPermission, "retainers.read");
  const cols = m.RETAINER_BALANCE_FIELDS.map((f) => f.key);
  assert.deepEqual(cols, ["currency", "balance", "drawn"]);
  assert.equal("RETAINER_IMPORT_DESCRIPTOR" in m, false);
  assert.equal("DRAWDOWN_IMPORT_DESCRIPTOR" in m, false);
});

test("assignment imports surface the real engine refusal and its remedy without writing", async (t) => {
  t.mock.method(RefResolver.prototype, 'resolveId', async () => '00000000-0000-4000-8000-000000000004');
  for (const dryRun of [true, false]) {
    const result = await m.assignmentPlanResource(orgId).write([
      { project: 'PROJECT', jobTitle: 'Engineer', weekStart: '2026-01-05', plannedHours: '8' },
      { project: 'PROJECT', jobTitle: 'Engineer', weekStart: '2026-01-04', plannedHours: '169' },
    ], 'upsert', { orgId, actorId, permissions: new Set(['resourcing.manage']), allowedSubsidiaryIds: scope, dryRun });
    assert.deepEqual(result, { created: 0, updated: 0, failed: 2, errors: [
      { row: 1, message: 'assignment_week_must_start_sunday: choose the Sunday that starts the timesheet week' },
      { row: 2, message: 'assignment_hours_out_of_range: enter a positive number of hours no greater than 168' },
    ] });
  }
});

test("export route and assignment resource preserve the acting user and safe reader refusal", async () => {
  state.reads = [];
  await assert.rejects(m.assignmentPlanResource(orgId).read({ actorId, allowedSubsidiaryIds: scope }), {
    message: 'scope_required: Pass the acting user and explicit subsidiary scope',
  });
  assert.equal(state.reads.length, 1);
  state.reads = [];
  await assert.rejects(POST(new Request('http://localhost/api/data/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ resource: 'resourcing-assignments', format: 'json' }) })), {
    message: 'scope_required: Pass the acting user and explicit subsidiary scope',
  }, 'reader refusal must not become an export success');
  assert.equal(state.reads.length, 1, 'the real route and registry reach the safe reader');
  assert.equal(state.reads[0]!.actorId, actorId);
  assert.equal(state.reads[0]!.orgId, orgId);
  assert.equal(state.reads[0]!.allowedSubsidiaryIds, scope);
  assert.equal(state.reads[0]!.recordType, 'resourcing_assignment');
});

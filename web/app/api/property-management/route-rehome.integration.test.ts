import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { SessionUser } from '../../../lib/auth';

/**
 * Property-management rehome races (H-PROPERTY-REHOME). The sibling
 * route-scope file pins the unlocked precheck decisions; this file proves
 * the snapshot and the locked recheck behind them:
 *
 * - GET returns a restricted caller only their own entity's properties,
 *   units, leases and deposits — scoped inside one engine snapshot, never
 *   filtered afterwards.
 * - The deposit-reconciliation GET scopes rows and totals the same way.
 * - A POST whose precheck passes and whose property is rehomed before the
 *   engine transaction locks it answers the uniform 404 and writes nothing:
 *   the race denial must not reveal the record exists.
 */
const root = pathToFileURL(process.cwd() + '/').href;
const engineRoot = new URL('../../../../engine/', import.meta.url).href;
const state: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __pmRehomeRace: state });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier.startsWith('@openbooks/engine/')) {
    return next(new URL(specifier.slice('@openbooks/engine/'.length), engineRoot).href, context);
  }
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__pmRehomeRace.user}' };
  if (specifier.startsWith('@/')) {
    const path = root + 'web/' + specifier.slice(2);
    for (const suffix of ['.ts', '.tsx', '/index.ts', '/index.tsx']) if (existsSync(new URL(path + suffix))) return next(path + suffix, context);
    return next(path, context);
  }
  return next(specifier, context);
} });
const { sql } = await import('drizzle-orm');
const { db, pool, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts');
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts');
const { createManagedProperty, createPropertyUnit } = await import('@openbooks/engine/src/property/management.ts');
const { GET, POST } = await import('./route.ts');
const { GET: reconGET } = await import('./deposit-reconciliation/route.ts');

const DB = !!process.env.OPENBOOKS_DB_URL;
const post = (body: Record<string, unknown>) => POST(new Request('http://openbooks.test/api/property-management', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}));

interface Fixture {
  orgId: string; actorId: string; subA: string; subB: string;
  propA: string; propB: string; unitA: string;
}

async function seed(): Promise<{ orgId: string; fx: Fixture }> {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = await withBypassContext(() => createScratchUser(org.orgId, 'Property clerk', 'property_clerk'));
  await withBypassContext(() => db.execute(sql`update app_roles set permissions='["ar.read","ar.create"]'::jsonb,
    subsidiary_restriction=${JSON.stringify({ mode: 'list', subsidiaryIds: [org.subsidiaryId] })}::jsonb
    where org_id=${org.orgId} and key='property_clerk'`));
  await withBypassContext(() => db.execute(sql`update orgs set settings=jsonb_set(coalesce(settings,'{}'::jsonb),'{features}',
    coalesce(settings->'features','{}'::jsonb)||'{"propertyManagement":true}'::jsonb) where id=${org.orgId}`));
  const subB = randomUUID();
  await withBypassContext(() => db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
    values (${subB}, ${org.orgId}, ${org.subsidiaryId}, 'Second entity', 'CAD', 'CA')`));
  const common = { orgId: org.orgId, actorId, allowedSubsidiaryIds: null as ReadonlySet<string> | null };
  const propA = (await withBypassContext(() => createManagedProperty({
    ...common, subsidiaryId: org.subsidiaryId, code: 'PROP-A', name: 'Entity A house', propertyType: 'residential',
  }))).id;
  const propB = (await withBypassContext(() => createManagedProperty({
    ...common, subsidiaryId: subB, code: 'PROP-B', name: 'Entity B house', propertyType: 'residential',
  }))).id;
  const unitA = (await withBypassContext(() => createPropertyUnit({ ...common, propertyId: propA, code: 'A-101' }))).id;
  return { orgId: org.orgId, fx: { orgId: org.orgId, actorId, subA: org.subsidiaryId, subB, propA, propB, unitA } };
}

function session(fx: Fixture): SessionUser {
  return { id: fx.actorId, orgId: fx.orgId, name: 'Property clerk', email: 'clerk@scratch.test', roles: [], isSuperAdmin: false,
    envKind: 'production', productionOrgId: fx.orgId, homeOrgId: fx.orgId, homeUserId: fx.actorId };
}

test('GET shows a restricted caller only their own entity', { skip: !DB }, async () => {
  const { orgId, fx } = await seed();
  try {
    state.user = session(fx);
    const response = await withOrgContext(orgId, () => GET());
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    const body = await response.json() as {
      properties: Array<{ id: string }>; units: Array<{ id: string; propertyId: string }>;
      leases: Array<{ propertyId: string }>; deposits: Array<{ leaseId: string }>;
      camPools: unknown[]; overdueByLease: unknown[];
    };
    assert.deepEqual(body.properties.map((row) => String(row.id)), [fx.propA]);
    assert.deepEqual(body.units.map((row) => String(row.id)), [fx.unitA]);
    assert.ok(body.leases.every((row) => String(row.propertyId) === fx.propA));
    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes(fx.propB), 'no hidden property id leaks anywhere in the workspace');
  } finally {
    state.user = null;
    await withBypassContext(() => dropScratchOrg(orgId));
  }
});

test('deposit reconciliation scopes rows and totals to the caller entity', { skip: !DB }, async () => {
  const { orgId, fx } = await seed();
  try {
    state.user = session(fx);
    const response = await withOrgContext(orgId, () => reconGET(new Request('http://openbooks.test/api/property-management/deposit-reconciliation')));
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    const body = await response.json() as {
      rows: Array<{ propertyId: string }>;
      totals: { discrepancies: number; configurationRequired: number };
    };
    assert.equal(body.rows.length, 1);
    assert.equal(String(body.rows[0]!.propertyId), fx.propA);
    assert.ok(!JSON.stringify(body).includes(fx.propB), 'no hidden property id leaks into rows or totals');
  } finally {
    state.user = null;
    await withBypassContext(() => dropScratchOrg(orgId));
  }
});

/** Retry signal for shared-box infrastructure flake (never a product verdict). */
class RaceRetry extends Error {}

/**
 * POST blocked behind a rehome answers the uniform 404 and writes nothing.
 *
 * Each attempt races a genuinely concurrent writer: the holder pins the
 * property row, the POST's unlocked precheck still sees entity A and passes,
 * and the engine transaction queues on the held lock — then the property
 * moves to the hidden entity and the locked recheck must refuse with the
 * uniform not-found instead of writing. Attempts are independent scratch
 * orgs; only infrastructure signatures retry (a parked waiter that never
 * appears within a short window, or a query the box kills mid-race) — any
 * other outcome is a product signal and fails at once. Short attempts keep
 * each roll of the dice cheap on a shared box: a healthy race parks in
 * seconds, and a missing engine lock could never look like a timeout (the
 * POST would complete instead and fail loudly below).
 */
test('POST blocked behind a rehome answers the uniform 404 and writes nothing', { skip: !DB }, async () => {
  let lastRetry: unknown = null;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      await raceOnce();
      return;
    } catch (error) {
      if (error instanceof RaceRetry) { lastRetry = error; continue; }
      throw error;
    }
  }
  throw lastRetry;
});

async function raceOnce(): Promise<void> {
  const { orgId, fx } = await seed();
  try {
    state.user = session(fx);
    // Warm the POST stack (tsx compile, pool, authz) before the race: a
    // cold first write can eat most of the waiter deadline on a loaded box
    // and time out the poll below for no product reason. The race asserts
    // against the post-warmup name, so this write cannot mask the refusal.
    const warm = await withOrgContext(orgId, () => post({
      action: 'updateUnit', unitId: fx.unitA, code: 'A-101', name: 'Warmed name',
    }));
    assert.equal(warm.status, 200, JSON.stringify(await warm.clone().json()));
    const beforeRow = (await withBypassContext(() => db.execute(
      sql`select name from property_units where id = ${fx.unitA} and org_id = ${orgId}`,
    ))).rows[0] as { name: string | null } | undefined;
    const before = beforeRow?.name ?? null;
    // Hold the property row: the POST precheck (unlocked) still sees entity
    // A and passes, while the engine transaction queues behind this lock.
    const holder = await pool.connect();
    try {
      // Bypass and lock inside the transaction: a SET LOCAL issued before
      // BEGIN is a no-op, and a pooled connection inherits whatever GUCs
      // the previous checkout left behind — both failure modes silently
      // lock zero rows and leave the race below with nothing to wait on. The row
      // count asserts the pin, so a setup failure is loud, not a timeout.
      await holder.query('begin');
      await holder.query("select set_config('app.bypass_rls', 'on', true)");
      const held = await holder.query('select id from managed_properties where id = $1 for update', [fx.propA]);
      assert.equal(held.rows.length, 1, 'holder must pin the property row for the race');
      let settled = false;
      const pending = withOrgContext(orgId, () => {
        return post({
          action: 'updateUnit', unitId: fx.unitA, code: 'A-101', name: 'Raced rename',
        });
      }).then(
        (value) => { settled = true; return value; },
        (reason: unknown) => { settled = true; throw reason; },
      );
      // Wait until the POST has reached the engine's property lock query,
      // then move the property to the hidden entity and release the hold:
      // the locked recheck must observe the move and refuse. Any non-idle
      // backend running the lock text counts — executing, IO-stalled, or
      // queued on the held row (a SELECT FOR UPDATE against a locked row
      // takes its tuple lock speculatively and waits on the locker's
      // transaction id, which a `not granted ... relname` poll on pg_locks
      // never sees). Idle backends are excluded: pooled connections retain
      // their last query text, including earlier lock queries. Once the
      // rehome commits, the engine's locked re-read joins the latest row
      // version, so the refusal no longer depends on winning a timing race.
      // Poll slowly to avoid adding load to a saturated server.
      // Give the POST a fixed window to reach the engine's property lock
      // query past its unlocked precheck, then check once whether it is
      // parked there: any non-idle backend running the lock text counts —
      // executing, IO-stalled, or queued on the held row (a SELECT FOR
      // UPDATE against a locked row takes its tuple lock speculatively and
      // waits on the locker's transaction id, which a `not granted ...
      // relname` poll on pg_locks never sees). Idle backends are excluded:
      // pooled connections retain their last query text. If the POST has
      // not arrived, roll back and retry fresh rather than polling: a
      // polling loop measurably loads this shared server while the POST
      // needs it. Once the rehome commits, the engine's locked re-read
      // joins the latest row version, so a parked POST cannot complete
      // against the stale entity. If the POST settled first instead, fail
      // at once with its real outcome rather than timing out blind.
      await new Promise((resolve) => setTimeout(resolve, 5000));
      if (settled) {
        let status: number | null = null;
        let body: unknown = null;
        let failure: unknown = null;
        try {
          const early = await pending;
          status = early.status;
          try { body = await early.json(); } catch { body = null; }
        } catch (error) { failure = error; }
        if (failure !== null || status === 500) {
          throw new RaceRetry(
            `POST settled before the rehome (status ${status}): ${failure instanceof Error ? failure.message : JSON.stringify(body)}`,
          );
        }
        throw new Error(
          `POST settled before the rehome with status ${status}: ${JSON.stringify(body)}`,
        );
      }
      const waiting = (await holder.query(
        `select count(*)::int as n from pg_stat_activity
           where datname = current_database() and pid <> pg_backend_pid()
             and state <> 'idle' and query ilike '%managed_properties%for update%'`)).rows[0].n as number;
      if (waiting === 0) throw new RaceRetry('POST never reached the property lock');
      await holder.query('update managed_properties set subsidiary_id = $1 where id = $2', [fx.subB, fx.propA]);
      await holder.query('commit');
      const response = await pending;
      assert.equal(settled, true);
      assert.equal(response.status, 404, JSON.stringify(await response.clone().json()));
      assert.deepEqual(await response.json(), { error: 'not found' });
    } finally {
      // Roll back before releasing: on a retry the holder's transaction is
      // still open, and a pooled connection never rolls back on its own —
      // without this the abandoned row lock would block later attempts.
      await holder.query('rollback').catch(() => undefined);
      holder.release();
    }
    const afterRow = (await withBypassContext(() => db.execute(
      sql`select name from property_units where id = ${fx.unitA} and org_id = ${orgId}`,
    ))).rows[0] as { name: string | null } | undefined;
    const after = afterRow?.name ?? null;
    assert.equal(after, before, 'the refused write changed nothing');
  } finally {
    state.user = null;
    await withBypassContext(() => dropScratchOrg(orgId));
  }
}

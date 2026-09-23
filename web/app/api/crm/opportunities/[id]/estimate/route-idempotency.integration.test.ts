import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { resolveAppModule } from '../../../../../../lib/test-module-hooks'
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { SessionUser } from '../../../../../../lib/auth';

// C5: estimate conversion took no Idempotency-Key, so each call consumed a
// number and inserted a new draft quote — a retry or double click created
// two quotes. The caller now sends one key per action: an identical retry
// replays the first quote, a reused key over changed inputs conflicts, and
// a fresh key deliberately starts a new revision. Real route, real
// database; only identity, i18n and module resolution are scripted.
const session: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __estimateC5Session: session });
const root = pathToFileURL(process.cwd() + "/").href;
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return (key, values) => key + (values ? ':' + Object.values(values).join(',') : '')};export async function getLocale(){return 'en'}" };
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__estimateC5Session.user}' };
  const app = resolveAppModule(specifier, context, next, root);
  if (app) return app;
  return next(specifier,context);
}});
const { sql } = await import('drizzle-orm');
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { ensureCrmDefaults } = await import('@openbooks/engine/src/crm/crm.ts');
const { POST } = await import('./route');
const { NextRequest } = await import('next/server');

const DB = !!process.env.OPENBOOKS_DB_URL;
const post = (id: string, key?: string) => new NextRequest('http://audit.local', {
  method: 'POST',
  body: JSON.stringify({}),
  headers: key === undefined ? {} : { 'Idempotency-Key': key },
});
const paramsOf = (id: string) => ({ params: Promise.resolve({ id }) });

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg());
  const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Seller', 'owner'));
  await withBypassContext(async () => {
    await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='owner'`);
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"crm":true,"ar":true}'::jsonb) where id=${org.orgId}`);
  });
  session.user = { id: actor, orgId: org.orgId, name: 'Seller', email: 'seller@example.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor };
  const statusId = await withOrgContext(org.orgId, async () => {
    await ensureCrmDefaults(org.orgId, actor);
    return (await db.execute<{ id: string }>(sql`select id from crm_opportunity_statuses where org_id=${org.orgId} and is_default and is_active order by sequence limit 1`)).rows[0]!.id;
  });
  const opp = (await withBypassContext(() => db.execute<{ id: string }>(sql`
    insert into crm_opportunities (org_id, opportunity_number, title, party_id, owner_user_id, status_id, probability, forecast_category, currency, projected_amount, weighted_amount, is_active, created_by, updated_by)
    values (${org.orgId}, 'OPP-C5', 'Big deal', ${org.customerId}, ${actor}, ${statusId}, 80, 'upside', 'CAD', '300.0000', '240.0000', true, ${actor}, ${actor})
    returning id`))).rows[0]!.id;
  await withBypassContext(async () => {
    for (const [n, description, amount] of [[1, 'Service', '100.0000'], [2, 'Support', '200.0000']] as const) {
      await db.execute(sql`
        insert into crm_opportunity_lines (org_id, opportunity_id, line_number, item_id, description, quantity, unit, unit_price, amount, probability, expected_amount, created_by, updated_by)
        values (${org.orgId}, ${opp}, ${n}, ${org.items.service}, ${description}, '1.0000', 'each', ${amount}, ${amount}, 80, ${amount}, ${actor}, ${actor})`);
    }
  });
  return { org, opp };
}
async function quoteIds(orgId: string) {
  return (await db.execute<{ id: string }>(sql`select id from documents where org_id=${orgId} and kind='quote' order by document_number`)).rows.map((r) => r.id);
}

test('two identical retries yield one quote, replaying the first', { skip: !DB }, async () => {
  const { org, opp } = await fixture();
  try {
    const key = randomUUID();
    const first = await POST(post(opp, key), paramsOf(opp));
    assert.equal(first.status, 201, await first.clone().text());
    const firstId = (await first.json() as { id: string }).id;
    const second = await POST(post(opp, key), paramsOf(opp));
    assert.equal(second.status, 200);
    assert.equal((await second.json() as { id: string }).id, firstId);
    assert.deepEqual(await quoteIds(org.orgId), [firstId]);
  } finally {
    session.user = null;
    await dropScratchOrg(org.orgId);
  }
});

test('a reused key over an edited opportunity conflicts', { skip: !DB }, async () => {
  const { org, opp } = await fixture();
  try {
    const key = randomUUID();
    const first = await POST(post(opp, key), paramsOf(opp));
    assert.equal(first.status, 201, await first.clone().text());
    await db.execute(sql`update crm_opportunities set title='Bigger deal' where id=${opp}`);
    const retry = await POST(post(opp, key), paramsOf(opp));
    assert.equal(retry.status, 409);
    assert.match(await retry.json().then((b) => b.error as string), /opportunities\.estimateKeyConflict/);
    assert.equal((await quoteIds(org.orgId)).length, 1);
  } finally {
    session.user = null;
    await dropScratchOrg(org.orgId);
  }
});

test('a fresh key deliberately starts a second quote', { skip: !DB }, async () => {
  const { org, opp } = await fixture();
  try {
    const first = await POST(post(opp, randomUUID()), paramsOf(opp));
    assert.equal(first.status, 201, await first.clone().text());
    const second = await POST(post(opp, randomUUID()), paramsOf(opp));
    assert.equal(second.status, 201, await second.clone().text());
    assert.equal((await quoteIds(org.orgId)).length, 2);
  } finally {
    session.user = null;
    await dropScratchOrg(org.orgId);
  }
});

test('a missing key is refused before anything is written', { skip: !DB }, async () => {
  const { org, opp } = await fixture();
  try {
    const response = await POST(post(opp), paramsOf(opp));
    assert.equal(response.status, 400);
    assert.match(await response.json().then((b) => b.error as string), /opportunities\.estimateKeyRequired/);
    assert.deepEqual(await quoteIds(org.orgId), []);
    const bogus = await POST(post(opp, 'not-a-uuid'), paramsOf(opp));
    assert.equal(bogus.status, 400);
    assert.deepEqual(await quoteIds(org.orgId), []);
  } finally {
    session.user = null;
    await dropScratchOrg(org.orgId);
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { resolveAppModule } from '../../../../../../lib/test-module-hooks'
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { SessionUser } from '../../../../../../lib/auth';

// C4: opportunity → estimate silently dropped itemless lines. The per-line
// INSERT … SELECT FROM items matched zero rows for item_id NULL, so the line
// vanished while the header total kept the full projected amount. Document
// lines require an item or an account (doc_lines_target) and opportunity
// lines carry no account, so an itemless line has nowhere to post —
// inventing one would be a silent financial fallback. The conversion now
// refuses by name, listing the lines, before the number is consumed or
// anything is written. Real route, real database; only identity, i18n and
// module resolution are scripted.
const session: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __estimateC4Session: session });
const root = pathToFileURL(process.cwd() + "/").href;
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return (key, values) => key + (values ? ':' + Object.values(values).join(',') : '')};export async function getLocale(){return 'en'}" };
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__estimateC4Session.user}' };
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
const post = () => new NextRequest('http://audit.local', {
  method: 'POST',
  body: JSON.stringify({}),
  headers: { 'Idempotency-Key': randomUUID() },
});
const paramsOf = (id: string) => ({ params: Promise.resolve({ id }) });

async function fixture(itemless: boolean) {
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
    values (${org.orgId}, 'OPP-C4', 'Big deal', ${org.customerId}, ${actor}, ${statusId}, 80, 'upside', 'CAD', '300.0000', '240.0000', true, ${actor}, ${actor})
    returning id`))).rows[0]!.id;
  await withBypassContext(async () => {
    for (const [n, item, description, amount] of [
      [1, org.items.service, 'Service', '100.0000'],
      [2, itemless ? null : org.items.service, itemless ? 'Travel expenses' : 'Support', '200.0000'],
    ] as const) {
      await db.execute(sql`
        insert into crm_opportunity_lines (org_id, opportunity_id, line_number, item_id, description, quantity, unit, unit_price, amount, probability, expected_amount, created_by, updated_by)
        values (${org.orgId}, ${opp}, ${n}, ${item}, ${description}, '1.0000', 'each', ${amount}, ${amount}, 80, ${amount}, ${actor}, ${actor})`);
    }
  });
  return { org, opp };
}
async function quoteCount(orgId: string) {
  return (await db.execute(sql`select id from documents where org_id=${orgId} and kind='quote'`)).rows.length;
}

test('itemized lines convert with matching counts, amounts and total', { skip: !DB }, async () => {
  const { org, opp } = await fixture(false);
  try {
    const response = await POST(post(), paramsOf(opp));
    assert.equal(response.status, 201, await response.clone().text());
    const quoteId = (await response.json() as { id: string }).id;
    const quote = (await db.execute(sql`select total from documents where id=${quoteId}`)).rows[0]!;
    const quoteLines = (await db.execute(sql`select line_number, amount from document_lines where document_id=${quoteId} order by line_number`)).rows as { line_number: number; amount: string }[];
    // Source line count and amounts equal the created quote's lines and total.
    assert.equal(quoteLines.length, 2);
    assert.equal(quoteLines[0]!.amount, '100.0000');
    assert.equal(quoteLines[1]!.amount, '200.0000');
    assert.equal(quote.total, '300.0000');
  } finally {
    session.user = null;
    await dropScratchOrg(org.orgId);
  }
});

test('an itemless line refuses by name with nothing written', { skip: !DB }, async () => {
  const { org, opp } = await fixture(true);
  try {
    const response = await POST(post(), paramsOf(opp));
    assert.equal(response.status, 422);
    assert.match(await response.json().then((b) => b.error as string), /opportunities\.estimateItemlessLines:2/);
    assert.equal(await quoteCount(org.orgId), 0);
  } finally {
    session.user = null;
    await dropScratchOrg(org.orgId);
  }
});

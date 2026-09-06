import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { SessionUser } from '../auth';

// Regression coverage (X3): list_open_items called openItems() without the
// caller's subsidiary allowlist, so a restricted assistant/MCP caller saw every
// open AR/AP item in the organization. Fixture mirrors cash-scope.integration.
const root = pathToFileURL(process.cwd() + '/').href;
const state: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __openItemsScope: state });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" };
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__openItemsScope.user}' };
  if (specifier.startsWith('@/')) {
    const path = root + 'web/' + specifier.slice(2);
    for (const suffix of ['.ts', '.tsx', '/index.ts', '/index.tsx']) if (existsSync(new URL(path + suffix))) return next(path + suffix, context);
    return next(path, context);
  }
  return next(specifier, context);
} });
const { sql } = await import('drizzle-orm');
const { db, withOrgContext } = await import('@openbooks/engine/src/db.ts');
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts');
const { postDocument } = await import('@openbooks/engine/src/posting.ts');
const { getAuthz } = await import('../authz');
const { executeAssistantTool } = await import('./registry');

type Item = { documentNumber: string };

for (const mode of ['all', 'restricted', 'empty'] as const) {
  test(`list_open_items subsidiary scope: ${mode}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    try {
      const actor = await createScratchUser(org.orgId, 'Open items reviewer', 'open_items_reviewer');
      const hidden = randomUUID();
      const restriction = mode === 'all' ? { mode: 'all' } : { mode: 'list', subsidiaryIds: mode === 'empty' ? [] : [org.subsidiaryId] };
      await db.execute(sql`update app_roles set permissions='["ap.read","ar.read","assistant.use"]'::jsonb, subsidiary_restriction=${JSON.stringify(restriction)}::jsonb where org_id=${org.orgId} and key='open_items_reviewer'`);
      state.user = { id: actor, orgId: org.orgId, name: 'Open items reviewer', email: 'open@scratch.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor };
      await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${hidden},${org.orgId},${org.subsidiaryId},'Hidden','CAD','CA')`);
      await db.execute(sql`insert into party_subsidiaries(org_id,party_id,subsidiary_id) values (${org.orgId},${org.vendorId},${hidden}),(${org.orgId},${org.customerId},${hidden})`);
      for (const [label, sub] of [['VISIBLE', org.subsidiaryId], ['HIDDEN', hidden]] as const) {
        for (const kind of ['vendor_bill', 'customer_invoice'] as const) {
          const id = randomUUID();
          const party = kind === 'vendor_bill' ? org.vendorId : org.customerId;
          await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,party_id,document_date,posting_date,currency,fx_rate,subtotal,tax_total,total,created_by)
            values (${id},${org.orgId},${kind},'draft',${`${label}-${kind}`},${sub},${party},${org.date},${org.date},'CAD','1','100','0','100',${actor})`);
          await db.execute(sql`insert into document_lines(org_id,document_id,line_number,account_id,quantity,unit_price,amount,tax_amount,tax_input_amount,created_by)
            values (${org.orgId},${id},1,${kind === 'customer_invoice' ? org.accounts.revenue : org.accounts.cogs},'1','100','100','0','0',${actor})`);
          await db.execute(sql`update documents set status='approved' where id=${id} and org_id=${org.orgId}`);
          await postDocument(id, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });
        }
      }
      await withOrgContext(org.orgId, async () => {
        const authz = await getAuthz();
        assert.ok(authz);
        for (const side of ['ap', 'ar'] as const) {
          const result = await executeAssistantTool(authz, 'list_open_items', { side, asOf: org.date });
          assert.equal(result.ok, true, JSON.stringify(result));
          assert.ok(result.ok);
          const numbers = ((result.data as { items: Item[] }).items).map((item) => item.documentNumber).sort();
          const kind = side === 'ap' ? 'vendor_bill' : 'customer_invoice';
          const expected = mode === 'all' ? [`HIDDEN-${kind}`, `VISIBLE-${kind}`] : mode === 'empty' ? [] : [`VISIBLE-${kind}`];
          assert.deepEqual(numbers, expected, `${side}/${mode}`);
          assert.equal((result.data as { totalCount: number }).totalCount, expected.length);
        }
      });
    } finally {
      state.user = null;
      await dropScratchOrg(org.orgId);
    }
  });
}

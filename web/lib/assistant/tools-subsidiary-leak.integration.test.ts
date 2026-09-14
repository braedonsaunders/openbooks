import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { SessionUser } from '../auth';

// Regression coverage (wave 2): several assistant/MCP read tools ran raw SQL
// without the caller's subsidiary allowlist, so a restricted caller saw
// cross-subsidiary rows the UI surfaces hide. Fixture mirrors
// open-items-scope.integration: a VISIBLE root subsidiary and a HIDDEN child,
// one restricted role, and the same tool-execution entry the chat and MCP
// server share.
const root = pathToFileURL(process.cwd() + '/').href;
const state: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __docScopeLeak: state });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" };
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__docScopeLeak.user}' };
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
const { getAuthz } = await import('../authz');
const { executeAssistantTool } = await import('./registry');

const PROBE_PERMS = ["ap.read", "ar.read", "parties.read", "projects.read", "assistant.use"];

async function seedScopedOrg() {
  const org = await createScratchOrg();
  const actor = await createScratchUser(org.orgId, 'Scope prober', 'scope_prober');
  const hidden = randomUUID();
  await db.execute(sql`update app_roles set permissions=${JSON.stringify(PROBE_PERMS)}::jsonb, subsidiary_restriction=${JSON.stringify({ mode: 'list', subsidiaryIds: [org.subsidiaryId] })}::jsonb where org_id=${org.orgId} and key='scope_prober'`);
  state.user = { id: actor, orgId: org.orgId, name: 'Scope prober', email: 'probe@scratch.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor };
  await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${hidden},${org.orgId},${org.subsidiaryId},'Hidden','CAD','CA')`);
  return { org, actor, hidden };
}

/** One draft document carrying a label in its number; drafts are listable. */
async function seedDocument(orgId: string, subsidiaryId: string, kind: string, number: string, total = '100'): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,document_date,currency,subtotal,tax_total,total)
    values (${id},${orgId},${kind},'draft',${number},${subsidiaryId},'2026-07-15','CAD',${total},'0',${total})`);
  return id;
}

for (const mode of ['restricted', 'all'] as const) {
  test(`find_documents subsidiary scope: ${mode}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const { org, hidden } = await seedScopedOrg();
    try {
      if (mode === 'all') {
        await db.execute(sql`update app_roles set subsidiary_restriction=${JSON.stringify({ mode: 'all' })}::jsonb where org_id=${org.orgId} and key='scope_prober'`);
      }
      for (const sub of [org.subsidiaryId, hidden] as const) {
        const label = sub === org.subsidiaryId ? 'VISIBLE' : 'HIDDEN';
        await seedDocument(org.orgId, sub, 'vendor_bill', `${label}-BILL`);
        await seedDocument(org.orgId, sub, 'customer_invoice', `${label}-INV`);
      }
      await withOrgContext(org.orgId, async () => {
        const authz = await getAuthz();
        assert.ok(authz);
        const result = await executeAssistantTool(authz, 'find_documents', {});
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.ok(result.ok);
        const numbers = ((result.data as { items: { documentNumber: string }[] }).items)
          .map((item) => item.documentNumber).sort();
        assert.deepEqual(
          numbers,
          mode === 'all'
            ? ['HIDDEN-BILL', 'HIDDEN-INV', 'VISIBLE-BILL', 'VISIBLE-INV']
            : ['VISIBLE-BILL', 'VISIBLE-INV'],
          `${mode}: a restricted caller must not list hidden-subsidiary documents`,
        );
      });
    } finally {
      state.user = null;
      await dropScratchOrg(org.orgId);
    }
  });
}

test('party_concentration scopes posted documents to the caller subsidiary', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  // party_concentration summed posted invoices org-wide with no subsidiary
  // predicate, so a restricted caller saw hidden-subsidiary revenue totals
  // and party names.
  const { org, actor, hidden } = await seedScopedOrg();
  try {
    const { postDocument } = await import('@openbooks/engine/src/posting.ts');
    const parties: Record<string, string> = {};
    for (const [label, sub] of [['VISIBLE', org.subsidiaryId], ['HIDDEN', hidden]] as const) {
      const partyId = randomUUID();
      await db.execute(sql`insert into parties(id,org_id,kind,display_name) values (${partyId},${org.orgId},'customer',${`${label} Customer`})`);
      await db.execute(sql`insert into party_subsidiaries(org_id,party_id,subsidiary_id) values (${org.orgId},${partyId},${sub})`);
      parties[label] = partyId;
      const id = randomUUID();
      const total = label === 'VISIBLE' ? '1000' : '9000';
      await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,party_id,document_date,posting_date,currency,fx_rate,subtotal,tax_total,total,created_by)
        values (${id},${org.orgId},'customer_invoice','draft',${`${label}-CONC`},${sub},${partyId},'2026-07-15','2026-07-15','CAD','1',${total},'0',${total},${actor})`);
      await db.execute(sql`insert into document_lines(org_id,document_id,line_number,account_id,quantity,unit_price,amount,tax_amount,tax_input_amount,created_by)
        values (${org.orgId},${id},1,${org.accounts.revenue},'1',${total},${total},'0','0',${actor})`);
      await db.execute(sql`update documents set status='approved' where id=${id} and org_id=${org.orgId}`);
      await postDocument(id, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });
    }
    await withOrgContext(org.orgId, async () => {
      const authz = await getAuthz();
      assert.ok(authz);
      const result = await executeAssistantTool(authz, 'party_concentration', {
        side: 'customer', fromDate: '2026-07-01', toDate: '2026-07-31',
      });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.ok(result.ok);
      const rows = (result.data as { rows: { display_name: string; amount: string }[] }).rows;
      assert.deepEqual(rows.map((r) => r.display_name), ['VISIBLE Customer']);
      assert.equal(rows[0]?.amount, '1000.0000');
    });
  } finally {
    state.user = null;
    await dropScratchOrg(org.orgId);
  }
});

test('project_profitability scopes projects to the caller subsidiary', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  // project_profitability listed every project and opened any of them by id
  // with no subsidiary predicate, while the UI project loader scopes every
  // surface to the caller's allowlist.
  const { org, hidden } = await seedScopedOrg();
  try {
    const ids: Record<string, string> = {};
    for (const [label, sub] of [['VISIBLE', org.subsidiaryId], ['HIDDEN', hidden]] as const) {
      const id = randomUUID();
      await db.execute(sql`insert into projects(id,org_id,subsidiary_id,name) values (${id},${org.orgId},${sub},${`${label} Project`})`);
      ids[label] = id;
    }
    await withOrgContext(org.orgId, async () => {
      const authz = await getAuthz();
      assert.ok(authz);
      const list = await executeAssistantTool(authz, 'project_profitability', {});
      assert.equal(list.ok, true, JSON.stringify(list));
      assert.ok(list.ok);
      const names = ((list.data as { projects: { name: string }[] }).projects).map((p) => p.name);
      assert.deepEqual(names, ['VISIBLE Project']);
      const hiddenSingle = await executeAssistantTool(authz, 'project_profitability', { projectId: ids['HIDDEN'] });
      assert.equal(hiddenSingle.ok, false, `hidden project must read as missing, got ${JSON.stringify(hiddenSingle)}`);
      const visibleSingle = await executeAssistantTool(authz, 'project_profitability', { projectId: ids['VISIBLE'] });
      assert.equal(visibleSingle.ok, true, JSON.stringify(visibleSingle));
    });
  } finally {
    state.user = null;
    await dropScratchOrg(org.orgId);
  }
});

test('get_document hides a hidden-subsidiary document from a restricted caller', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org, hidden } = await seedScopedOrg();
  try {
    const visibleId = await seedDocument(org.orgId, org.subsidiaryId, 'vendor_bill', 'VISIBLE-ONE');
    const hiddenId = await seedDocument(org.orgId, hidden, 'vendor_bill', 'HIDDEN-ONE');
    await withOrgContext(org.orgId, async () => {
      const authz = await getAuthz();
      assert.ok(authz);
      const visible = await executeAssistantTool(authz, 'get_document', { documentId: visibleId });
      assert.equal(visible.ok, true, JSON.stringify(visible));
      const hiddenResult = await executeAssistantTool(authz, 'get_document', { documentId: hiddenId });
      assert.equal(hiddenResult.ok, false, `hidden document must read as missing, got ${JSON.stringify(hiddenResult)}`);
    });
  } finally {
    state.user = null;
    await dropScratchOrg(org.orgId);
  }
});

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

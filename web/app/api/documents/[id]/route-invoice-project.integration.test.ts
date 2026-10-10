import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'

// A draft invoice's Project field stays editable: an invoice that arrives
// without a project link (an estimate that named none, a hand-keyed draft)
// can still be tagged before posting, so it counts in invoiced to date.
// Only the session gate is stubbed; handler, service, and storage are real.
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __documentInvoiceProjectState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '../../../../lib/authz' || specifier === '@/lib/authz') return virtual(`
      import { permissionSetCovers } from '@openbooks/engine/src/organization/permissions.ts';
      export async function getAuthz() {
        const s = globalThis.__documentInvoiceProjectState;
        return { user: { orgId: s.orgId, id: s.actorId, isSuperAdmin: false }, permissions: new Set(['ar.read', 'ar.create', 'ar.post']), allowedSubsidiaryIds: null };
      }
      export function can(authz, permission) { return permissionSetCovers(authz.permissions, permission) }
      export function guardSubsidiaryScope() { return null }
      export function subsidiariesInScope() { return true }
    `)
    if (context.parentURL?.startsWith('data:') && specifier.startsWith('@openbooks/')) {
      return next(specifier, { ...context, parentURL: import.meta.url })
    }
    return next(specifier, context)
  },
})
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { documentRevisionCounterSql } = await import("../../../../../engine/src/records/revision.ts");
const { PATCH } = await import('./route.ts')

async function revision(orgId: string, id: string): Promise<string> {
  return (await withOrgContext(orgId, () => db.execute<{ revision: string }>(sql`select ${documentRevisionCounterSql(sql`revision_seq`)} as revision from documents where id=${id} and org_id=${orgId}`))).rows[0]!.revision
}

test('a draft invoice accepts a project link through the document edit path', async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Invoice Editor', 'admin'));
    state.orgId = org.orgId;
    state.actorId = actor;
    const customer = randomUUID();
    const project = randomUUID();
    await withBypassContext(() => db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active) values (${customer},${org.orgId},'customer','Invoice Customer',${org.subsidiaryId},true)`));
    await withBypassContext(() => db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active) values (${project},${org.orgId},${org.subsidiaryId},'INV-PROJ','Invoice job',${customer},'active',true)`));
    const invoice = randomUUID();
    await withBypassContext(() => db.execute(sql`insert into documents (id, org_id, kind, status, document_number, party_id, document_date, subsidiary_id, currency, subtotal, tax_total, total, custom)
      values (${invoice}, ${org.orgId}, 'customer_invoice', 'draft', ${'INV-' + invoice.slice(0, 8)}, ${customer}, ${org.date}, ${org.subsidiaryId}, 'CAD', '4200', '0', '4200', '{}'::jsonb)`));
    const token = await revision(org.orgId, invoice);
    const response = await withOrgContext(org.orgId, () => PATCH(
      new Request(`http://documents.test/api/documents/${invoice}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: project, expectedUpdatedAt: token }),
      }),
      { params: Promise.resolve({ id: invoice }) },
    ));
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    const stored = (await withBypassContext(() => db.execute<{ project_id: string | null }>(sql`select project_id from documents where id=${invoice}`))).rows[0]?.project_id;
    assert.equal(stored, project);
  } finally {
    state.orgId = '';
    state.actorId = '';
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

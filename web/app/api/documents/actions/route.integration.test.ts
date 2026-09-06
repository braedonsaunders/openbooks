import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import type { SessionUser } from '../../../../lib/auth'

/**
 * /api/documents/actions accepts exactly two verbs. Anything else must be
 * refused at the boundary: the route once treated every non-'submit' action
 * as a post while checking only the CREATE permission, so a caller holding
 * ar.create (no ar.post) could post an approved invoice by sending any
 * unknown action string.
 */
const root = pathToFileURL(process.cwd() + '/').href
const state: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __documentActionsUser: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === 'next-intl/server') return virtual('export async function getTranslations(){return (key)=>key}; export async function getLocale(){return "en"}')
    if ((specifier === './auth' || specifier.endsWith('/lib/auth')) && context.parentURL?.endsWith('/web/lib/authz.ts')) {
      return virtual('export async function currentUser(){return globalThis.__documentActionsUser.user}')
    }
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { POST } = await import('./route')

const request = (body: unknown) => new Request('http://audit.local/api/documents/actions', { method: 'POST', body: JSON.stringify(body) })

async function documentState(orgId: string, id: string) {
  return withBypassContext(async () =>
    (await db.execute<{ status: string; postedEntryId: string | null }>(sql`
      select status, posted_entry_id as "postedEntryId" from documents where id = ${id} and org_id = ${orgId}`)).rows[0]!,
  )
}

test('documents/actions refuses unknown actions instead of posting them under the create permission', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Sales rep', 'sales_rep'))
    const invoiceId = randomUUID()
    await withBypassContext(async () => {
      await db.execute(sql`update app_roles set permissions='["ar.read","ar.create"]'::jsonb where org_id=${org.orgId} and key='sales_rep'`)
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, status, document_number, subsidiary_id, party_id,
           document_date, due_date, currency, fx_rate, subtotal, tax_total, total, created_by)
        values (${invoiceId}, ${org.orgId}, 'customer_invoice', 'draft', ${`ACT-${invoiceId.slice(0, 8)}`},
                ${org.subsidiaryId}, ${org.customerId}, ${org.date}, ${org.date},
                'CAD', '1', '100', '0', '100', ${actor})`)
      await db.execute(sql`
        insert into document_lines
          (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
        values (${org.orgId}, ${invoiceId}, 1, ${org.accounts.revenue}, '1', '100', '100', '0', '0')`)
      await db.execute(sql`update documents set status = 'approved' where id = ${invoiceId} and org_id = ${org.orgId}`)
    })
    state.user = { id: actor, orgId: org.orgId, name: 'Sales rep', email: 'rep@scratch.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor }

    await withOrgContext(org.orgId, async () => {
      // The explicit post verb is correctly permissioned already.
      assert.equal((await POST(request({ action: 'post', documentId: invoiceId }))).status, 403)
      // Every other spelling must be a validation failure, never a post.
      for (const action of ['x', 'POST', '', undefined, null, 1]) {
        const response = await POST(request({ action, documentId: invoiceId }))
        assert.equal(response.status, 400, `action ${JSON.stringify(action)} → ${JSON.stringify(await response.clone().json())}`)
      }
      // submit on an approved document is a lifecycle refusal, not a post.
      assert.equal((await POST(request({ action: 'submit', documentId: invoiceId }))).status, 422)
    })
    assert.deepEqual(await documentState(org.orgId, invoiceId), { status: 'approved', postedEntryId: null })

    // With the post grant the same document posts through the same route.
    await withBypassContext(() => db.execute(sql`update app_roles set permissions='["ar.read","ar.create","ar.post"]'::jsonb where org_id=${org.orgId} and key='sales_rep'`))
    await withOrgContext(org.orgId, async () => {
      const posted = await POST(request({ action: 'post', documentId: invoiceId }))
      assert.equal(posted.status, 200, JSON.stringify(await posted.clone().json()))
    })
    const after = await documentState(org.orgId, invoiceId)
    assert.equal(after.status, 'posted')
    assert.ok(after.postedEntryId)
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

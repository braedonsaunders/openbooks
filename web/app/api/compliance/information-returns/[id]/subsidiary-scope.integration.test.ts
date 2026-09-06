import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import type { SessionUser } from '@/lib/auth'

// Live-Postgres regression: the information-return list and create paths
// enforce subsidiary scope, but the four by-id routes (action, export,
// recipient copies, recipient edit) only checked permission and org, and the
// engine they call is scope-blind — so an entity-restricted caller could
// compute, finalize, file, void, export or edit another legal entity's filing
// by id. Every by-id route now loads the filing's subsidiary and applies the
// shared gate BEFORE any action, failing closed with the same 404 body the
// list-miss and create paths use.

const root = pathToFileURL(process.cwd() + '/').href
const state: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __irScopeUser: state })
const virtual = (source: string) => ({
  shortCircuit: true as const,
  url: 'data:text/javascript,' + encodeURIComponent(source),
})
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === 'next-intl/server') {
      return virtual('export async function getTranslations(){ const t=(k)=>k; t.has=()=>false; return t }; export async function getLocale(){ return "en" }')
    }
    if (
      (specifier === './auth' || specifier.endsWith('/lib/auth')) &&
      context.parentURL?.endsWith('/web/lib/authz.ts')
    ) {
      return virtual('export async function currentUser(){ return globalThis.__irScopeUser.user }')
    }
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
// Query-suffixed URLs keep these imports out of the module cache shared with
// sibling suites (same seam as the recipients route test).
const actionUrl = './route.ts?ir-scope'
const exportUrl = './export/route.ts?ir-scope'
const copiesUrl = './copies/route.ts?ir-scope'
const recipientUrl = './recipients/[recipientId]/route.ts?ir-scope'
const { POST: action } = (await import(actionUrl)) as typeof import('./route.ts')
const { GET: exportCsv } = (await import(exportUrl)) as typeof import('./export/route.ts')
const { GET: copies } = (await import(copiesUrl)) as typeof import('./copies/route.ts')
const { PATCH: editRecipient } = (await import(recipientUrl)) as typeof import('./recipients/[recipientId]/route.ts')
hooks.deregister()

const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { ensureFiling } = await import('@openbooks/engine/src/information-returns.ts')

const DB = !!process.env.OPENBOOKS_DB_URL

const json = (body: unknown) =>
  new Request('http://openbooks.test/api/compliance/information-returns/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
const params = (id: string) => ({ params: Promise.resolve({ id }) })

async function restrict(orgId: string, ids: string[] | null) {
  const value = ids === null ? { mode: 'all' } : { mode: 'list', subsidiaryIds: ids }
  await withBypassContext(() =>
    db.execute(sql`update app_roles set subsidiary_restriction=${JSON.stringify(value)}::jsonb where org_id=${orgId} and key='ir_scope_reviewer'`),
  )
}

test('information-return by-id routes fail closed on another entity\'s filing', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'IR reviewer', 'ir_scope_reviewer'))
    const hidden = randomUUID()
    const taxYear = Number(org.date.slice(0, 4)) - 1
    await withBypassContext(async () => {
      await db.execute(sql`
        update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,subcontractorCompliance}', 'true'::jsonb, true)
         where id = ${org.orgId}`)
      await db.execute(sql`
        update app_roles set permissions='["compliance.read","compliance.manage","compliance.file"]'::jsonb
         where org_id=${org.orgId} and key='ir_scope_reviewer'`)
      await db.execute(sql`
        insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
        values (${hidden},${org.orgId},${org.subsidiaryId},'Hidden entity','CAD','CA')`)
    })
    await restrict(org.orgId, [org.subsidiaryId])
    const hiddenFiling = await ensureFiling({ orgId: org.orgId, taxYear, formType: '1099-NEC', subsidiaryId: hidden, currency: 'USD', actorId: actor })
    const rootFiling = await ensureFiling({ orgId: org.orgId, taxYear, formType: '1099-NEC', subsidiaryId: null, currency: 'USD', actorId: actor })
    const visibleFiling = await ensureFiling({ orgId: org.orgId, taxYear, formType: '1099-NEC', subsidiaryId: org.subsidiaryId, currency: 'USD', actorId: actor })
    state.user = {
      id: actor,
      orgId: org.orgId,
      name: 'IR reviewer',
      email: 'ir@scratch.test',
      roles: [],
      isSuperAdmin: false,
      envKind: 'production',
      productionOrgId: org.orgId,
      homeOrgId: org.orgId,
      homeUserId: actor,
    }

    await withOrgContext(org.orgId, async () => {
      // Out-of-scope (and org-root, which the list also hides from restricted
      // callers) filings are indistinguishable from missing ones on every route.
      for (const id of [hiddenFiling.id, rootFiling.id]) {
        for (const [label, response] of [
          ['action', await action(json({ action: 'compute' }), params(id))],
          ['export', await exportCsv(new Request('http://openbooks.test'), params(id))],
          ['copies', await copies(new Request('http://openbooks.test'), params(id))],
          ['recipient', await editRecipient(
            new Request('http://openbooks.test', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'excluded', exclusionReason: 'x' }) }),
            { params: Promise.resolve({ id, recipientId: randomUUID() }) },
          )],
        ] as const) {
          assert.equal(response.status, 404, `${label} must 404 for filing ${id}`)
          assert.deepEqual(await response.json(), { error: 'not found' }, `${label} must use the list-miss body`)
        }
        // Nothing happened to the hidden filing: no compute evidence was written.
        const audits = await db.execute<{ n: number }>(sql`
          select count(*)::int as n from audit_log
           where org_id=${org.orgId} and table_name='information_return_filings' and row_id=${id} and action='compute'`)
        assert.equal(audits.rows[0]!.n, 0)
      }

      // The caller's own entity passes the gate and reaches the engine.
      const ownCompute = await action(json({ action: 'compute' }), params(visibleFiling.id))
      assert.equal(ownCompute.status, 200, JSON.stringify(await ownCompute.clone().json()))
      assert.equal((await exportCsv(new Request('http://openbooks.test'), params(visibleFiling.id))).status, 200)
      const ownCopies = await copies(new Request('http://openbooks.test'), params(visibleFiling.id))
      assert.equal(ownCopies.status, 422) // not frozen yet — the engine's answer, not the gate's
      const ownEdit = await editRecipient(
        new Request('http://openbooks.test', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'excluded', exclusionReason: 'x' }) }),
        { params: Promise.resolve({ id: visibleFiling.id, recipientId: randomUUID() }) },
      )
      assert.match(((await ownEdit.json()) as { error: string }).error, /recipient not found/) // the engine was reached

      // An unrestricted caller still reaches every filing.
      await restrict(org.orgId, null)
      const allCompute = await action(json({ action: 'compute' }), params(hiddenFiling.id))
      assert.equal(allCompute.status, 200, JSON.stringify(await allCompute.clone().json()))
      assert.equal((await exportCsv(new Request('http://openbooks.test'), params(rootFiling.id))).status, 200)
    })
  } finally {
    state.user = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import type { SessionUser } from '@/lib/auth'

// Live-Postgres regression: the waiver list, create, and lifecycle routes all
// enforce subsidiary scope, but the printable-PDF route only checked
// permission and org — so an entity-restricted reader could print another
// legal entity's waiver (amounts, parties, signatures) by id. The route now
// loads the waiver's project subsidiary and applies the shared gate BEFORE
// rendering, failing closed with the same 404 body the other misses use.

const root = pathToFileURL(process.cwd() + '/').href
const state: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __lwPdfScopeUser: state })
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
      return virtual('export async function currentUser(){ return globalThis.__lwPdfScopeUser.user }')
    }
    // Authz proof, not a render proof: never launch Chromium in this suite. A
    // thin re-export-plus-override of the real @openbooks/pdf surface: the
    // star carries every name this double does not stub (notably
    // RendererUnavailableError, which lib/api/pdf-renderer imports), so the
    // next export added to the package cannot break this double's link again.
    // Importing the real index never launches Chromium — the browser pool
    // only launches on first render — so the stub stays hermetic.
    if (specifier === '@openbooks/pdf') {
      return virtual(`export * from '${root}packages/pdf/src/index.ts'; export async function renderHtmlDocumentPdf(){ return Buffer.from("MOCK-WAIVER-PDF") }`)
    }
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
// Query-suffixed URL keeps this import out of the module cache shared with
// sibling suites.
const pdfUrl = './route.ts?lw-pdf-scope'
const { GET: waiverPdf } = (await import(pdfUrl)) as typeof import('./route.ts')
hooks.deregister()

const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')

const DB = !!process.env.OPENBOOKS_DB_URL

const params = (id: string) => ({ params: Promise.resolve({ id }) })

test('waiver printable PDF fails closed on another entity\u2019s waiver', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Waiver reviewer', 'lw_scope_reviewer'))
    const hidden = randomUUID()
    const visibleProject = randomUUID()
    const hiddenProject = randomUUID()
    const visibleWaiver = randomUUID()
    const hiddenWaiver = randomUUID()
    await withBypassContext(async () => {
      await db.execute(sql`
        update orgs set settings = coalesce(settings, '{}'::jsonb)
          || '{"features": {"subcontractorCompliance": true, "projects": true}}'::jsonb
         where id = ${org.orgId}`)
      await db.execute(sql`
        update app_roles set permissions = '["compliance.read"]'::jsonb,
               subsidiary_restriction = ${JSON.stringify({ mode: 'list', subsidiaryIds: [org.subsidiaryId] })}::jsonb
         where org_id = ${org.orgId} and key = 'lw_scope_reviewer'`)
      await db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
        values (${hidden}, ${org.orgId}, ${org.subsidiaryId}, 'Hidden entity', 'CAD', 'CA')`)
      await db.execute(sql`
        insert into projects (id, org_id, name, subsidiary_id, is_active)
        values (${visibleProject}, ${org.orgId}, 'Visible project', ${org.subsidiaryId}, true),
               (${hiddenProject}, ${org.orgId}, 'Hidden project', ${hidden}, true)`)
      await db.execute(sql`
        insert into lien_waivers
          (id, org_id, waiver_number, direction, party_id, project_id, waiver_type,
           through_date, amount, currency, created_by)
        values (${visibleWaiver}, ${org.orgId}, 'LW-VISIBLE-1', 'received', ${org.vendorId},
                ${visibleProject}, 'conditional_progress', ${org.date}, '1000.0000', 'CAD', ${actor}),
               (${hiddenWaiver}, ${org.orgId}, 'LW-HIDDEN-1', 'received', ${org.vendorId},
                ${hiddenProject}, 'conditional_progress', ${org.date}, '7777.0000', 'CAD', ${actor})`)
    })
    state.user = {
      id: actor,
      orgId: org.orgId,
      name: 'Waiver reviewer',
      email: 'lw@scratch.test',
      roles: [],
      isSuperAdmin: false,
      envKind: 'production',
      productionOrgId: org.orgId,
      homeOrgId: org.orgId,
      homeUserId: actor,
    }

    await withOrgContext(org.orgId, async () => {
      const denied = await waiverPdf(new Request('http://openbooks.test'), params(hiddenWaiver))
      assert.equal(denied.status, 404, 'hidden-entity waiver PDF must 404')
      assert.deepEqual(await denied.json(), { error: 'not found' })

      const allowed = await waiverPdf(new Request('http://openbooks.test'), params(visibleWaiver))
      assert.equal(allowed.status, 200, 'visible waiver PDF must render')
      assert.equal(Buffer.from(await allowed.arrayBuffer()).toString(), 'MOCK-WAIVER-PDF')
    })
  } finally {
    state.user = null
    await dropScratchOrg(org.orgId)
  }
})

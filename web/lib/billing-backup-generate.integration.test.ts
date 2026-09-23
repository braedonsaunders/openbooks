import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { SessionUser } from './auth'

// End to end: a backup-required billing request goes from invoiced to
// downloadable with no manual step. create-invoice assembles the packet
// with the draft — frozen to the request's backup type at invoicing, before
// the invoice can be issued — so the Download backup link in the project
// billing tab streams a PDF immediately. Rendering is stubbed to one blank
// page (see the @openbooks/pdf hook): the precision suite covers packet
// content, and the real renderer owns a browser pool that outlives the test
// process.
const root = pathToFileURL(process.cwd() + '/').href
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __billingBackupGenerateSession: session })
Object.assign(globalThis, { __billingBackupGenerateStubPdf: null as Buffer | null })
const pdfStub = {
  shortCircuit: true as const,
  url: 'data:text/javascript,' + encodeURIComponent([
    'export async function renderHtmlDocumentPdf() { return globalThis.__billingBackupGenerateStubPdf }',
    'export function compileTemplateHtml(sourceHtml) { return { compiledHtml: sourceHtml } }',
    'export function renderTemplate(tpl) { return tpl }',
    'export function sanitizeRenderedHtml(html) { return html }',
    'export function sanitizeTokenizedFragment(html) { return html }',
  ].join(';')),
}
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    if (specifier === '@openbooks/pdf') return pdfStub
    if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) {
      return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__billingBackupGenerateSession.user}' }
    }
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { sql } = await import('drizzle-orm')
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { randomUUID } = await import('node:crypto')
const { PDFDocument } = await import('pdf-lib')
{
  const onePage = await PDFDocument.create()
  onePage.addPage([612, 792])
  Object.assign(globalThis, { __billingBackupGenerateStubPdf: Buffer.from(await onePage.save()) })
}
const { createBillingRequest } = await import('./billing-requests')
const { GET } = await import('../app/api/billing-requests/[id]/backup/route')
const { POST: POST_INVOICE } = await import('../app/api/billing-requests/[id]/create-invoice/route')
const DB = !!process.env.OPENBOOKS_DB_URL

test('a backup-required request is downloadable the moment it is invoiced', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actor = await withBypassContext(async () => {
      await db.execute(sql`update orgs set settings = jsonb_set(settings, '{controlAccounts,projectRevenue}', to_jsonb(${org.accounts.revenue}::text), true) where id = ${org.orgId}`)
      return createScratchUser(org.orgId, 'Billing controller', 'reviewer')
    })
    await withBypassContext(() => db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`))
    session.user = {
      id: actor, orgId: org.orgId, name: 'Billing controller', email: 'backup@scratch.test',
      roles: [], isSuperAdmin: false, envKind: 'production' as const,
      productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor,
    }
    const project = randomUUID()
    await withBypassContext(() => db.execute(sql`insert into projects(id, org_id, subsidiary_id, code, name, customer_id, status, is_active) values (${project}, ${org.orgId}, ${org.subsidiaryId}, 'BACKUP-E2E', 'Backup end to end', ${org.customerId}, 'active', true)`))
    const request = await withOrgContext(org.orgId, () => createBillingRequest(org.orgId, actor, {
      projectId: project, basis: 'draw_amount', drawAmount: '100', backupRequired: true, backupType: 'costed_timesheets',
    }))
    const invoiced = await withOrgContext(org.orgId, () =>
      POST_INVOICE(new Request('http://audit.local/api/create-invoice', { method: 'POST' }), { params: Promise.resolve({ id: request.id }) }))
    assert.equal(invoiced.status, 200)
    // No manual generation step: the same Download backup link the project
    // billing tab renders streams the packet straight away.
    const download = await withOrgContext(org.orgId, () =>
      GET(new Request('http://audit.local/api/backup', { method: 'GET' }), { params: Promise.resolve({ id: request.id }) }))
    assert.equal(download.status, 200)
    assert.equal(download.headers.get('content-type'), 'application/pdf')
    assert.ok((await download.arrayBuffer()).byteLength > 0)
  } finally {
    session.user = null
    await dropScratchOrg(org.orgId)
  }
})

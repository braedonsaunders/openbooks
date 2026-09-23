import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { SessionUser } from './auth'

// Issued backup packets are immutable: regenerating one would replace the
// file the customer received and delete the old versions, rewriting history.
// POST refuses with a 422 once the invoice is approved or posted and a packet
// exists; a first packet for an issued invoice still generates. Packet
// rendering itself is stubbed to one blank page (see the @openbooks/pdf
// hook): the precision suite covers packet content, and the real renderer
// owns a browser pool that outlives the test process.
const root = pathToFileURL(process.cwd() + '/').href
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __billingBackupSession: session })
Object.assign(globalThis, { __billingBackupStubPdf: null as Buffer | null })
// Thin re-export-plus-override of the real @openbooks/pdf surface: every name
// this double does not stub (notably RendererUnavailableError, which
// lib/api/pdf-renderer imports) resolves to the real implementation, so the
// next export added to the package cannot break this double's link again.
// Importing the real index never launches Chromium — the browser pool only
// launches on first render — so the stub stays hermetic.
const pdfStub = {
  shortCircuit: true as const,
  url: 'data:text/javascript,' + encodeURIComponent([
    `export * from '${root}packages/pdf/src/index.ts'`,
    'export async function renderHtmlDocumentPdf() { return globalThis.__billingBackupStubPdf }',
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
      return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__billingBackupSession.user}' }
    }
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { sql } = await import('drizzle-orm')
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { randomUUID } = await import('node:crypto')
const { createBillingRequest } = await import('./billing-requests')
const { generateInvoiceFromBillingRequest } = await import('./billing')
const { GET, POST: POST_BACKUP } = await import('../app/api/billing-requests/[id]/backup/route')
const { PDFDocument } = await import('pdf-lib')
{
  const onePage = await PDFDocument.create()
  onePage.addPage([612, 792])
  Object.assign(globalThis, { __billingBackupStubPdf: Buffer.from(await onePage.save()) })
}
const DB = !!process.env.OPENBOOKS_DB_URL

type Org = Awaited<ReturnType<typeof createScratchOrg>>

async function setup() {
  const org = await withBypassContext(() => createScratchOrg())
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
  await withBypassContext(() => db.execute(sql`insert into projects(id, org_id, subsidiary_id, code, name, customer_id, status, is_active) values (${project}, ${org.orgId}, ${org.subsidiaryId}, 'BACKUP', 'Backup probe', ${org.customerId}, 'active', true)`))
  return { org, actor, project }
}

async function backupRowCount(org: Org, documentId: string): Promise<number> {
  const r = await withBypassContext(() => db.execute<{ n: string }>(sql`
    select count(*)::text as n from invoice_backups where org_id = ${org.orgId} and document_id = ${documentId}`))
  return Number(r.rows[0]?.n ?? 0)
}

test('backup POST generates for a draft and GET then streams it', { skip: !DB }, async () => {
  const { org, actor, project } = await setup()
  try {
    const request = await withOrgContext(org.orgId, () => createBillingRequest(org.orgId, actor, {
      projectId: project, basis: 'draw_amount', drawAmount: '100', backupRequired: true, backupType: 'costed_timesheets',
    }))
    const generated = await withOrgContext(org.orgId, () => generateInvoiceFromBillingRequest(org.orgId, actor, request.id, null))
    const posted = await withOrgContext(org.orgId, () =>
      POST_BACKUP(new Request('http://audit.local/api/backup', { method: 'POST' }), { params: Promise.resolve({ id: request.id }) }))
    assert.equal(posted.status, 200)
    const stored = await withOrgContext(org.orgId, () =>
      GET(new Request('http://audit.local/api/backup', { method: 'GET' }), { params: Promise.resolve({ id: request.id }) }))
    assert.equal(stored.status, 200)
    assert.equal(stored.headers.get('content-type'), 'application/pdf')
    assert.ok((await stored.arrayBuffer()).byteLength > 0)
    assert.equal(await backupRowCount(org, generated.id), 1)
  } finally {
    session.user = null
    await dropScratchOrg(org.orgId)
  }
})

test('backup POST refuses to regenerate an issued invoice packet', { skip: !DB }, async () => {
  const { org, actor, project } = await setup()
  try {
    const request = await withOrgContext(org.orgId, () => createBillingRequest(org.orgId, actor, {
      projectId: project, basis: 'draw_amount', drawAmount: '100', backupRequired: true, backupType: 'costed_timesheets',
    }))
    const generated = await withOrgContext(org.orgId, () => generateInvoiceFromBillingRequest(org.orgId, actor, request.id, null))
    const first = await withOrgContext(org.orgId, () =>
      POST_BACKUP(new Request('http://audit.local/api/backup', { method: 'POST' }), { params: Promise.resolve({ id: request.id }) }))
    assert.equal(first.status, 200)
    const fileId = (await first.json() as { fileId: string }).fileId
    await withBypassContext(() => db.execute(sql`update documents set status = 'approved' where id = ${generated.id}`))
    const retry = await withOrgContext(org.orgId, () =>
      POST_BACKUP(new Request('http://audit.local/api/backup', { method: 'POST' }), { params: Promise.resolve({ id: request.id }) }))
    assert.equal(retry.status, 422)
    assert.match(String((await retry.json() as { error: string }).error), /immutable/)
    // The issued packet is untouched: same file, still exactly one row.
    const row = (await withBypassContext(() => db.execute<{ file_id: string }>(sql`
      select file_id from invoice_backups where org_id = ${org.orgId} and document_id = ${generated.id}`))).rows[0]
    assert.equal(row?.file_id, fileId)
    assert.equal(await backupRowCount(org, generated.id), 1)
  } finally {
    session.user = null
    await dropScratchOrg(org.orgId)
  }
})

test('backup POST still generates a first packet for an issued invoice', { skip: !DB }, async () => {
  const { org, actor, project } = await setup()
  try {
    const request = await withOrgContext(org.orgId, () => createBillingRequest(org.orgId, actor, {
      projectId: project, basis: 'draw_amount', drawAmount: '100', backupRequired: false,
    }))
    const generated = await withOrgContext(org.orgId, () => generateInvoiceFromBillingRequest(org.orgId, actor, request.id, null))
    // Approved (issued) directly: posting through the kernel would need a
    // full period close, which the lifecycle tests cover elsewhere.
    await withBypassContext(() => db.execute(sql`update documents set status = 'approved' where id = ${generated.id}`))
    const response = await withOrgContext(org.orgId, () =>
      POST_BACKUP(new Request('http://audit.local/api/backup', { method: 'POST' }), { params: Promise.resolve({ id: request.id }) }))
    assert.equal(response.status, 200)
  } finally {
    session.user = null
    await dropScratchOrg(org.orgId)
  }
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { SessionUser } from './auth'

// Covers required packets and source-read authorization without launching the PDF renderer.
const root = pathToFileURL(process.cwd() + '/').href
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __billingBackupSession: session })
Object.assign(globalThis, { __billingBackupStubPdf: null as Buffer | null })
// Re-export the real PDF package and override rendering to keep this DB test browser-free.
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
const { POST: POST_BACKUP } = await import('../app/api/billing-requests/[id]/backup/route')
const { requireInvoiceBackup, InvoiceBackupRequiredError, InvoiceBackupSourceAccessError, assembleInvoiceBackup } = await import('./invoice-backup')
const { toActionFailure } = await import('../app/api/documents/actions/action-failure')
const { advanceDocumentLifecycle } = await import('./application/documents')
const { ApplicationError } = await import('./application/errors')
const { applicationContextFromSession } = await import('./application/context')
const { PDFDocument } = await import('pdf-lib')
{
  const onePage = await PDFDocument.create()
  onePage.addPage([612, 792])
  Object.assign(globalThis, { __billingBackupStubPdf: Buffer.from(await onePage.save()) })
}
const DB = !!process.env.OPENBOOKS_DB_URL

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

test('the documents action mapper keeps the backup refusal as a 422', () => {
  const mapped = toActionFailure(new InvoiceBackupRequiredError())
  assert.equal(mapped.status, 422)
  assert.match(String(mapped.body.error), /backup packet/)
})

test('lifecycle submit refuses a backup-required invoice with no packet', { skip: !DB }, async () => {
  const { org, actor, project } = await setup()
  try {
    const request = await withOrgContext(org.orgId, () => createBillingRequest(org.orgId, actor, {
      projectId: project, basis: 'draw_amount', drawAmount: '100', backupRequired: true, backupType: 'costed_timesheets',
    }))
    const generated = await withOrgContext(org.orgId, () => generateInvoiceFromBillingRequest(org.orgId, actor, request.id, null))
    const context = applicationContextFromSession(
      {
        user: {
          id: actor, orgId: org.orgId, name: 'Billing controller', email: 'backup@scratch.test',
          roles: [], isSuperAdmin: false, envKind: 'production' as const,
          productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor,
        },
        permissions: new Set(['*']),
        allowedSubsidiaryIds: null,
      },
      'api',
      randomUUID(),
    )
    const error = await withOrgContext(org.orgId, () =>
      advanceDocumentLifecycle(context, {
        documentId: generated.id, action: 'submit', idempotencyKey: randomUUID(),
      }).then(
        () => null,
        (cause) => cause,
      ),
    )
    assert.ok(error instanceof ApplicationError, `expected an ApplicationError, got ${String(error)}`)
    assert.equal(error.code, 'invalid_input')
    assert.match(error.message, /backup packet/)
    const status = (await withBypassContext(() => db.execute<{ status: string }>(sql`
      select status from documents where id = ${generated.id}`))).rows[0]?.status
    assert.equal(status, 'draft')
  } finally {
    session.user = null
    await dropScratchOrg(org.orgId)
  }
})

test('requireInvoiceBackup fails closed only when a required packet is missing', { skip: !DB }, async () => {
  const { org, actor, project } = await setup()
  try {
    const required = await withOrgContext(org.orgId, () => createBillingRequest(org.orgId, actor, {
      projectId: project, basis: 'draw_amount', drawAmount: '100', backupRequired: true, backupType: 'costed_timesheets',
    }))
    const generated = await withOrgContext(org.orgId, () => generateInvoiceFromBillingRequest(org.orgId, actor, required.id, null))
    const invoiceLine = (await withBypassContext(() => db.execute<{ id: string }>(sql`select id from document_lines where org_id=${org.orgId} and document_id=${generated.id} order by line_number limit 1`))).rows[0]?.id
    assert.ok(invoiceLine)
    const source = randomUUID(), sourceLine = randomUUID()
    await withBypassContext(async () => {
      await db.execute(sql`insert into documents(id,org_id,kind,document_number,document_date,subsidiary_id,party_id,currency) values (${source},${org.orgId},'vendor_bill',${source},${org.date},${org.subsidiaryId},${org.vendorId},'CAD')`)
      await db.execute(sql`insert into document_lines(id,org_id,document_id,line_number,account_id,quantity,unit_price,amount,billed_by_line_id) values (${sourceLine},${org.orgId},${source},1,${org.accounts.cogs},1,1,1,${invoiceLine})`)
      await db.execute(sql`update app_roles set permissions='["ar.read","ar.create","documents.manage"]'::jsonb where org_id=${org.orgId} and key='reviewer'`)
    })
    const { uploadAndAttach } = await import('./file-cabinet')
    await withOrgContext(org.orgId, () => uploadAndAttach({ orgId: org.orgId, targetTable: 'documents', targetId: source, filename: 'Source.pdf', contentType: 'application/pdf', bytes: (globalThis as typeof globalThis & { __billingBackupStubPdf: Buffer }).__billingBackupStubPdf, createdBy: actor }))
    await assert.rejects(withOrgContext(org.orgId, () => assembleInvoiceBackup(org.orgId, actor, generated.id, 'purchases', null)), (error) => error instanceof InvoiceBackupSourceAccessError && error.permission === 'ap.read')
    await assert.rejects(
      withOrgContext(org.orgId, () => requireInvoiceBackup(org.orgId, generated.id)),
      /requires a backup packet/,
    )
    await withOrgContext(org.orgId, () =>
      POST_BACKUP(new Request('http://audit.local/api/backup', { method: 'POST' }), { params: Promise.resolve({ id: required.id }) }))
    await withOrgContext(org.orgId, () => requireInvoiceBackup(org.orgId, generated.id))
    // A manual invoice with no billing request passes untouched.
    const manual = randomUUID()
    await withBypassContext(() => db.execute(sql`
      insert into documents(id, org_id, kind, document_number, document_date, subsidiary_id, party_id, project_id, currency)
      values (${manual}, ${org.orgId}, 'customer_invoice', ${manual}, ${org.date}, ${org.subsidiaryId}, ${org.customerId}, ${project}, 'CAD')`))
    await withOrgContext(org.orgId, () => requireInvoiceBackup(org.orgId, manual))
  } finally {
    session.user = null
    await dropScratchOrg(org.orgId)
  }
})

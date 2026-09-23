import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { SessionUser } from './auth'

// A backup-required billing request is enforced where it matters: the draft
// leaves create-invoice with its packet already assembled, and no submit or
// post of its invoice succeeds while the packet is missing. Packet rendering
// itself is stubbed to one blank page (see the @openbooks/pdf hook): the
// precision suite covers packet content, and the real renderer owns a browser
// pool that outlives the test process.
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
const { requireInvoiceBackup } = await import('./invoice-backup')
const { POST: POST_BACKUP } = await import('../app/api/billing-requests/[id]/backup/route')
const { InvoiceBackupRequiredError } = await import('./invoice-backup')
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
    // The refusal leaves the draft unissued.
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

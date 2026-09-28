import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { registerHooks } from 'node:module'
import type { SessionUser } from './auth'

// A backup read (ar.read) never assembles the packet: generating persists a
// PDF plus file-cabinet evidence a reader must not be able to create. A GET
// with no stored packet is a 404 naming the generation remedy, and writes
// nothing.
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __billingBackupSession: session })
Object.assign(globalThis, { __billingBackupStubPdf: null as Buffer | null })
Object.assign(globalThis, { __billingBackupGenerateStubPdf: null as Buffer | null })
Object.assign(globalThis, { __billingBackupFailRender: false })
const root = pathToFileURL(process.cwd() + '/').href
const pdfStub = {
  shortCircuit: true as const,
  url: 'data:text/javascript,' + encodeURIComponent([
    `export * from '${root}packages/pdf/src/index.ts'`,
    'export async function renderHtmlDocumentPdf() { if (globalThis.__billingBackupFailRender) throw new Error("renderer unavailable"); return globalThis.__billingBackupGenerateStubPdf ?? globalThis.__billingBackupStubPdf }',
    'export function compileTemplateHtml(sourceHtml) { return { compiledHtml: sourceHtml } }',
    'export function renderTemplate(tpl) { return tpl }',
    'export function sanitizeRenderedHtml(html) { return html }',
    'export function sanitizeTokenizedFragment(html) { return html }',
  ].join(';')),
}
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@openbooks/pdf') return pdfStub
    if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) {
      return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__billingBackupSession.user}' }
    }
    return next(specifier, context)
  },
})
const { sql } = await import('drizzle-orm')
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { randomUUID } = await import('node:crypto')
const { createBillingRequest } = await import('./billing-requests')
const { generateInvoiceFromBillingRequest } = await import('./billing')
const { GET } = await import('../app/api/billing-requests/[id]/backup/route')
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

async function fileCount(org: Org): Promise<number> {
  const r = await withBypassContext(() => db.execute<{ n: string }>(sql`
    select count(*)::text as n from files where org_id = ${org.orgId}`))
  return Number(r.rows[0]?.n ?? 0)
}

test('backup GET with no stored packet is a 404 that writes nothing', { skip: !DB }, async () => {
  const { org, actor, project } = await setup()
  try {
    const request = await withOrgContext(org.orgId, () => createBillingRequest(org.orgId, actor, {
      projectId: project, basis: 'draw_amount', drawAmount: '100', backupRequired: true, backupType: 'costed_timesheets',
    }))
    const generated = await withOrgContext(org.orgId, () => generateInvoiceFromBillingRequest(org.orgId, actor, request.id, null))
    const filesBefore = await fileCount(org)
    const response = await withOrgContext(org.orgId, () =>
      GET(new Request('http://audit.local/api/backup', { method: 'GET' }), { params: Promise.resolve({ id: request.id }) }))
    assert.equal(response.status, 404)
    assert.match(String((await response.json() as { error: string }).error), /generate it from the billing request/)
    assert.equal(await backupRowCount(org, generated.id), 0)
    assert.equal(await fileCount(org), filesBefore)
  } finally {
    session.user = null
    await dropScratchOrg(org.orgId)
  }
})


const consolidatedRows = [
  { label: "billing backup generate", register: async () => {
        const assert = (await import("node:assert/strict")).default;
        const test = (await import("node:test")).default;
        const { registerHooks } = await import("node:module");
        const { pathToFileURL } = await import("node:url");
        type SessionUser = import("./auth").SessionUser;
        // End to end: a backup-required billing request goes from invoiced to
        // downloadable with no manual step. create-invoice assembles the packet
        // with the draft — frozen to the request's backup type at invoicing, before
        // the invoice can be issued — so the Download backup link in the project
        // billing tab streams a PDF immediately. Rendering is stubbed to one blank
        // page (see the @openbooks/pdf hook): the precision suite covers packet
        // content, and the real renderer owns a browser pool that outlives the test
        // process.
        const root = pathToFileURL(process.cwd() + '/').href
        const session = (globalThis as typeof globalThis & { __billingBackupSession: { user: SessionUser | null } }).__billingBackupSession
        Object.assign(globalThis, { __billingBackupGenerateSession: session })
        Object.assign(globalThis, { __billingBackupGenerateStubPdf: null as Buffer | null })
        // Flipped by the failure test to make the renderer throw, proving the
        // failure path end to end.
        Object.assign(globalThis, { __billingBackupFailRender: false })
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
            'export async function renderHtmlDocumentPdf() { if (globalThis.__billingBackupFailRender) throw new Error("renderer unavailable"); return globalThis.__billingBackupGenerateStubPdf }',
            'export function compileTemplateHtml(sourceHtml) { return { compiledHtml: sourceHtml } }',
            'export function renderTemplate(tpl) { return tpl }',
            'export function sanitizeRenderedHtml(html) { return html }',
            'export function sanitizeTokenizedFragment(html) { return html }',
          ].join(';')),
        }
        registerHooks({
          resolve(specifier, context, next) {
            if (specifier === '@openbooks/pdf') return pdfStub
            if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) {
              return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__billingBackupSession.user}' }
            }
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
          const bytes = Buffer.from(await onePage.save())
          Object.assign(globalThis, { __billingBackupGenerateStubPdf: bytes, __billingBackupStubPdf: bytes })
        }
        const { createBillingRequest } = await import('./billing-requests')
        const { GET, POST: POST_BACKUP } = await import('../app/api/billing-requests/[id]/backup/route')
        const { POST: POST_INVOICE } = await import('../app/api/billing-requests/[id]/create-invoice/route')
        const { advanceDocumentLifecycle } = await import('./application/documents')
        const { applicationContextFromSession } = await import('./application/context')
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

        test('a failed assembly is reported, Generate succeeds, and submit then passes', { skip: !DB }, async () => {
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
            await withBypassContext(() => db.execute(sql`insert into projects(id, org_id, subsidiary_id, code, name, customer_id, status, is_active) values (${project}, ${org.orgId}, ${org.subsidiaryId}, 'BACKUP-FAIL', 'Backup failure path', ${org.customerId}, 'active', true)`))
            const request = await withOrgContext(org.orgId, () => createBillingRequest(org.orgId, actor, {
              projectId: project, basis: 'draw_amount', drawAmount: '100', backupRequired: true, backupType: 'costed_timesheets',
            }))
            // The renderer fails: create-invoice still succeeds, but says so —
            // the draft stands with no packet.
            ;(globalThis as unknown as { __billingBackupFailRender: boolean }).__billingBackupFailRender = true
            try {
              const invoiced = await withOrgContext(org.orgId, () =>
                POST_INVOICE(new Request('http://audit.local/api/create-invoice', { method: 'POST' }), { params: Promise.resolve({ id: request.id }) }))
              assert.equal(invoiced.status, 200)
              const body = (await invoiced.json()) as { documentId: string; backup: { status: string; error?: string } }
              assert.equal(body.backup.status, 'failed')
              assert.match(String(body.backup.error), /generate it from the billing request/)
            } finally {
              ;(globalThis as unknown as { __billingBackupFailRender: boolean }).__billingBackupFailRender = false
            }
            // The operator's remedy — Generate — now succeeds through the same POST
            // the project tab calls.
            const generated = await withOrgContext(org.orgId, () =>
              POST_BACKUP(new Request('http://audit.local/api/backup', { method: 'POST' }), { params: Promise.resolve({ id: request.id }) }))
            assert.equal(generated.status, 200)
            // And the issue gate, which refused without a packet, now lets the
            // invoice through.
            const documentId = (await withBypassContext(() => db.execute<{ invoice_document_id: string }>(sql`
              select invoice_document_id from billing_requests where id = ${request.id}`))).rows[0]?.invoice_document_id
            assert.ok(documentId)
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
            const outcome = await withOrgContext(org.orgId, () =>
              advanceDocumentLifecycle(context, { documentId, action: 'submit', idempotencyKey: randomUUID() }))
            assert.equal((outcome.result as { status: string }).status, 'approved')
          } finally {
            session.user = null
            await dropScratchOrg(org.orgId)
          }
        })
  } },
  { label: "billing backup immutable", register: async () => {
        const assert = (await import("node:assert/strict")).default;
        const test = (await import("node:test")).default;
        const { registerHooks } = await import("node:module");
        const { pathToFileURL } = await import("node:url");
        type SessionUser = import("./auth").SessionUser;
        // Issued backup packets are immutable: regenerating one would replace the
        // file the customer received and delete the old versions, rewriting history.
        // POST refuses with a 422 once the invoice is approved or posted and a packet
        // exists; a first packet for an issued invoice still generates. Packet
        // rendering itself is stubbed to one blank page (see the @openbooks/pdf
        // hook): the precision suite covers packet content, and the real renderer
        // owns a browser pool that outlives the test process.
        const root = pathToFileURL(process.cwd() + '/').href
        const session = (globalThis as typeof globalThis & { __billingBackupSession: { user: SessionUser | null } }).__billingBackupSession
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
            if (specifier === '@openbooks/pdf') return pdfStub
            if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) {
              return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__billingBackupSession.user}' }
            }
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
  } },
  { label: "billing backup required", register: async () => {
        const assert = (await import("node:assert/strict")).default;
        const test = (await import("node:test")).default;
        const { registerHooks } = await import("node:module");
        const { pathToFileURL } = await import("node:url");
        type SessionUser = import("./auth").SessionUser;
        // Covers required packets and source-read authorization without launching the PDF renderer.
        const root = pathToFileURL(process.cwd() + '/').href
        const session = (globalThis as typeof globalThis & { __billingBackupSession: { user: SessionUser | null } }).__billingBackupSession
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
            if (specifier === '@openbooks/pdf') return pdfStub
            if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) {
              return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__billingBackupSession.user}' }
            }
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
  } },
] as const;

for (const row of consolidatedRows) await row.register();

const invoiceBackupPrecisionCases = [{ label: "invoice backup precision", register: async () => {
test('costed invoice backup preserves cents in large exact cost totals',{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
  const root=pathToFileURL(process.cwd()+'/').href;
  const capture={html:''};
  Object.assign(globalThis,{__backupPrecisionCapture:capture});
  const pdfStub={shortCircuit:true,url:'data:text/javascript,'+encodeURIComponent(`export * from '${root}packages/pdf/src/index.ts';export async function renderHtmlDocumentPdf(input){globalThis.__backupPrecisionCapture.html=input.bodyHtml;throw new Error("captured timesheet HTML")}`)};
  const hooks=registerHooks({resolve(specifier,context,next){
    if(context.parentURL?.includes('/web/lib/invoice-backup.ts')){
      if(specifier==='@openbooks/pdf')return pdfStub;
      if(specifier==='./pdf-templates/store')return {shortCircuit:true,url:'data:text/javascript,export async function resolvePdfTemplate(){return null}'};
      if(specifier==='./money-server')return {shortCircuit:true,url:'data:text/javascript,'+encodeURIComponent(`import {createMoneyFormatter} from '${root}web/lib/money-format.ts';export async function getMoneyFormatter(_org,currency){return createMoneyFormatter('en-CA',currency)}`)};
    }
    return next(specifier,context);
  }});
  const org=await withBypassContext(()=>createScratchOrg());
  try{
    const {assembleInvoiceBackup}=await import('./invoice-backup?backup-precision');
    const {createMoneyFormatter}=await import('./money-format');
    const {actor,invoice}=await withBypassContext(async()=>{
      const actor=await createScratchUser(org.orgId,'Backup controller','reviewer');
      const invoice=randomUUID(),line=randomUUID(),employee=randomUUID();
      await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id) values (${employee},${org.orgId},'employee','Backup worker',${org.subsidiaryId})`);
      await db.execute(sql`insert into documents(id,org_id,kind,document_number,document_date,subsidiary_id,party_id,currency) values (${invoice},${org.orgId},'customer_invoice',${invoice},${org.date},${org.subsidiaryId},${org.customerId},'CAD')`);
      await db.execute(sql`insert into document_lines(id,org_id,document_id,line_number,account_id,quantity,unit_price,amount) values (${line},${org.orgId},${invoice},1,${org.accounts.revenue},2,1,2)`);
      for(const cost of ['999999999999999.9000','0.0400'])await db.execute(sql`insert into time_entries(org_id,employee_party_id,worked_on,hours,cost_rate,cost_rate_currency,cost_rate_subsidiary_id,bill_rate,invoiced_by_line_id,billing_status,is_billable,status) values (${org.orgId},${employee},${org.date},1,${cost},'CAD',${org.subsidiaryId},1,${line},'billed',true,'approved')`);
      return {actor,invoice};
    });
    await assert.rejects(withOrgContext(org.orgId,()=>assembleInvoiceBackup(org.orgId,actor,invoice,'costed_timesheets',null)),/captured timesheet HTML/);
    const footer=capture.html.split('<tfoot>')[1];
    assert.ok(footer,'the actual timesheet renderer received a totals footer');
    assert.ok(footer.includes(createMoneyFormatter('en-CA','CAD').money('999999999999999.9400')),footer);
  }finally{hooks.deregister();delete (globalThis as typeof globalThis & {__backupPrecisionCapture?:unknown}).__backupPrecisionCapture;await withBypassContext(()=>dropScratchOrg(org.orgId));}
});
}}] as const; for (const row of invoiceBackupPrecisionCases) await row.register();

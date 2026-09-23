import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { SessionUser } from './auth'

// A backup read (ar.read) never assembles the packet: generating persists a
// PDF plus file-cabinet evidence a reader must not be able to create. A GET
// with no stored packet is a 404 naming the generation remedy, and writes
// nothing.
const root = pathToFileURL(process.cwd() + '/').href
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __billingBackupSession: session })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
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

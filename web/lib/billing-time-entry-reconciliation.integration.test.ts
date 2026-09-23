import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { SessionUser } from './auth'

// Every explicitly selected time entry must actually be billable when the
// invoice is cut: invoicing only the eligible subset while marking the
// request invoiced would silently drop the rest. The generator reconciles
// the selection against the billed entries and refuses naming the ones that
// cannot be billed, leaving the request open.
const root = pathToFileURL(process.cwd() + '/').href
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __billingTimeSelectionSession: session })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) {
      return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__billingTimeSelectionSession.user}' }
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
const DB = !!process.env.OPENBOOKS_DB_URL

async function setup() {
  const org = await withBypassContext(() => createScratchOrg())
  const { actor, project } = await withBypassContext(async () => {
    await db.execute(sql`update orgs set settings = jsonb_set(settings, '{controlAccounts,projectRevenue}', to_jsonb(${org.accounts.revenue}::text), true) where id = ${org.orgId}`)
    const actor = await createScratchUser(org.orgId, 'Billing controller', 'reviewer')
    const project = randomUUID()
    await db.execute(sql`insert into projects(id, org_id, subsidiary_id, code, name, customer_id, status, is_active) values (${project}, ${org.orgId}, ${org.subsidiaryId}, 'TIMESEL', 'Time selection probe', ${org.customerId}, 'active', true)`)
    return { actor, project }
  })
  return { org, actor, project }
}

async function seedEntry(org: Awaited<ReturnType<typeof setup>>['org'], project: string, overrides: { status?: string; billingStatus?: string } = {}): Promise<string> {
  const employee = randomUUID()
  const entry = randomUUID()
  await withBypassContext(async () => {
    await db.execute(sql`insert into parties(id, org_id, kind, display_name, subsidiary_id) values (${employee}, ${org.orgId}, 'employee', 'Billable worker', ${org.subsidiaryId})`)
    await db.execute(sql`insert into time_entries(id, org_id, employee_party_id, worked_on, hours, project_id, item_id, is_billable, status, billing_status, bill_rate) values (${entry}, ${org.orgId}, ${employee}, ${org.date}, 1, ${project}, ${org.items.service}, true, ${overrides.status ?? 'approved'}, ${overrides.billingStatus ?? 'unbilled'}, 100)`)
  })
  return entry
}

async function requestStatus(requestId: string): Promise<string> {
  const r = await withBypassContext(() => db.execute<{ status: string }>(sql`select status from billing_requests where id = ${requestId}`))
  return r.rows[0]?.status ?? 'missing'
}

test('invoicing refuses naming selected entries that are no longer billable', { skip: !DB }, async () => {
  const { org, actor, project } = await setup()
  try {
    const fresh = await seedEntry(org, project)
    const stale = await seedEntry(org, project)
    // Bill the stale entry through an earlier request so it is no longer eligible.
    const earlier = await withOrgContext(org.orgId, () => createBillingRequest(org.orgId, actor, {
      projectId: project, basis: 'time_selection', selectedTimeEntryIds: [stale],
    }))
    await withOrgContext(org.orgId, () => generateInvoiceFromBillingRequest(org.orgId, actor, earlier.id, null))
    const request = await withOrgContext(org.orgId, () => createBillingRequest(org.orgId, actor, {
      projectId: project, basis: 'time_selection', selectedTimeEntryIds: [fresh, stale],
    }))
    await assert.rejects(
      withOrgContext(org.orgId, () => generateInvoiceFromBillingRequest(org.orgId, actor, request.id, null)),
      (error: unknown) => {
        assert.match(String(error), new RegExp(stale))
        assert.match(String(error), /cannot be billed/)
        return true
      },
    )
    // The refusal leaves the request open: nothing was invoiced, nothing marked.
    assert.equal(await requestStatus(request.id), 'open')
    const freshRow = (await withBypassContext(() => db.execute<{ status: string }>(sql`
      select billing_status as status from time_entries where id = ${fresh}`))).rows[0]
    assert.equal(freshRow?.status, 'unbilled')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { SessionUser } from './auth'

// time_selection billing names its entries explicitly: an explicitly empty
// selection refuses at creation (it would otherwise bill every eligible
// entry on the project), and a present selection always scopes the invoice —
// even a final one, which widens only when nothing was selected.
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

test('time_selection creation refuses an explicitly empty selection', { skip: !DB }, async () => {
  const { org, actor, project } = await setup()
  try {
    await assert.rejects(
      withOrgContext(org.orgId, () => createBillingRequest(org.orgId, actor, {
        projectId: project, basis: 'time_selection', selectedTimeEntryIds: [],
      })),
      /empty selection would bill every eligible entry/,
    )
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('time_selection creation refuses invalid entry ids and wrong-basis selections', { skip: !DB }, async () => {
  const { org, actor, project } = await setup()
  try {
    await assert.rejects(
      withOrgContext(org.orgId, () => createBillingRequest(org.orgId, actor, {
        projectId: project, basis: 'time_selection', selectedTimeEntryIds: ['not-a-uuid'],
      })),
      /selected time entry is invalid/,
    )
    await assert.rejects(
      withOrgContext(org.orgId, () => createBillingRequest(org.orgId, actor, {
        projectId: project, basis: 'date_range', cutoffDate: org.date, selectedTimeEntryIds: [randomUUID()],
      })),
      /only for time-selection billing/,
    )
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('a present time selection scopes the invoice to exactly those entries', { skip: !DB }, async () => {
  const { org, actor, project } = await setup()
  try {
    const billed = await seedEntry(org, project)
    const unbilled = await seedEntry(org, project)
    const request = await withOrgContext(org.orgId, () => createBillingRequest(org.orgId, actor, {
      projectId: project, basis: 'time_selection', selectedTimeEntryIds: [billed],
    }))
    const invoice = await withOrgContext(org.orgId, () => generateInvoiceFromBillingRequest(org.orgId, actor, request.id, null))
    assert.equal(await requestStatus(request.id), 'invoiced')
    const rows = (await withBypassContext(() => db.execute<{ entry: string; status: string }>(sql`
      select id as entry, billing_status as status from time_entries where project_id = ${project} and org_id = ${org.orgId}`))).rows
    const byId = new Map(rows.map((r) => [r.entry, r.status]))
    assert.equal(byId.get(billed), 'billed')
    assert.equal(byId.get(unbilled), 'unbilled')
    assert.ok(invoice.id)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('invoicing refuses a time_selection request stored with an empty selection', { skip: !DB }, async () => {
  const { org, actor, project } = await setup()
  try {
    await seedEntry(org, project)
    const request = await withOrgContext(org.orgId, () => createBillingRequest(org.orgId, actor, {
      projectId: project, basis: 'date_range', cutoffDate: org.date,
    }))
    // A request predating the creation-time refusal, carrying the exact
    // defect shape: time_selection with an empty stored selection.
    await withBypassContext(() => db.execute(sql`
      update billing_requests set basis = 'time_selection', selected_time_entry_ids = '[]'::jsonb where id = ${request.id}`))
    await assert.rejects(
      withOrgContext(org.orgId, () => generateInvoiceFromBillingRequest(org.orgId, actor, request.id, null)),
      /empty time selection/,
    )
    assert.equal(await requestStatus(request.id), 'open')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('a final invoice keeps an explicit time selection instead of widening', { skip: !DB }, async () => {
  const { org, actor, project } = await setup()
  try {
    const billed = await seedEntry(org, project)
    const unbilled = await seedEntry(org, project)
    const request = await withOrgContext(org.orgId, () => createBillingRequest(org.orgId, actor, {
      projectId: project, basis: 'time_selection', invoiceType: 'final', selectedTimeEntryIds: [billed],
    }))
    await withOrgContext(org.orgId, () => generateInvoiceFromBillingRequest(org.orgId, actor, request.id, null))
    const left = (await withBypassContext(() => db.execute<{ status: string }>(sql`
      select billing_status as status from time_entries where id = ${unbilled}`))).rows[0]
    assert.equal(left?.status, 'unbilled')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

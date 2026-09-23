import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { SessionUser } from './auth'

// Rate-card commercial adjustments, priced through invoice generation:
// the card assignment selects WHICH adjustments apply, and each
// adjustment's own targets select WHICH lines they measure.
const root = pathToFileURL(process.cwd() + '/').href
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __billingRateAdjustmentSession: session })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) {
      return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__billingRateAdjustmentSession.user}' }
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

interface Fixture {
  org: Awaited<ReturnType<typeof createScratchOrg>>
  actor: string
  project: string
  otherCustomer: string
}

async function setup(): Promise<Fixture> {
  const org = await withBypassContext(() => createScratchOrg())
  const { actor, project, otherCustomer } = await withBypassContext(async () => {
    await db.execute(sql`update orgs set settings = jsonb_set(settings, '{controlAccounts,projectRevenue}', to_jsonb(${org.accounts.revenue}::text), true) where id = ${org.orgId}`)
    const actor = await createScratchUser(org.orgId, 'Billing controller', 'reviewer')
    const project = randomUUID()
    await db.execute(sql`insert into projects(id, org_id, subsidiary_id, code, name, customer_id, status, is_active) values (${project}, ${org.orgId}, ${org.subsidiaryId}, 'ADJ', 'Adjustment probe', ${org.customerId}, 'active', true)`)
    const otherCustomer = randomUUID()
    await db.execute(sql`insert into parties (id, org_id, kind, display_name, is_active, custom) values (${otherCustomer}, ${org.orgId}, 'customer', 'Other Customer', true, '{}'::jsonb)`)
    await db.execute(sql`insert into customer_roles (org_id, party_id, is_active) values (${org.orgId}, ${otherCustomer}, true)`)
    return { actor, project, otherCustomer }
  })
  return { org, actor, project, otherCustomer }
}

/** A rate card carrying one separate percent surcharge with one target. */
async function seedCard(fx: Fixture, target: { targetType: string; targetValueId: string | null; targetValueText?: string | null }, value = '10.0000'): Promise<void> {
  const { org, project } = fx
  const book = randomUUID(), version = randomUUID(), adjustment = randomUUID()
  await withBypassContext(async () => {
    await db.execute(sql`insert into item_rate_books (id, org_id, code, name, currency, is_active) values (${book}, ${org.orgId}, 'ADJ-RATES', 'Adjustment rates', 'CAD', true)`)
    await db.execute(sql`insert into item_rate_versions (id, org_id, rate_book_id, effective_from, status) values (${version}, ${org.orgId}, ${book}, '2026-07-01', 'draft')`)
    await db.execute(sql`insert into labor_rate_version_policies (org_id, version_id, derivation_policy) values (${org.orgId}, ${version}, 'explicit')`)
    await db.execute(sql`insert into labor_rate_adjustments (id, org_id, version_id, code, name, category, calculation, value, presentation) values (${adjustment}, ${org.orgId}, ${version}, 'SURCH', 'Probe surcharge', 'surcharge', 'percent', ${value}, 'separate')`)
    await db.execute(sql`insert into labor_rate_adjustment_targets (org_id, adjustment_id, target_type, target_value_id, target_value_text) values (${org.orgId}, ${adjustment}, ${target.targetType}, ${target.targetValueId}, ${target.targetValueText ?? null})`)
    await db.execute(sql`update item_rate_versions set status = 'active' where id = ${version} and org_id = ${org.orgId}`)
    await db.execute(sql`insert into item_rate_book_assignments (org_id, rate_book_id, project_id, date_basis, is_active) values (${org.orgId}, ${book}, ${project}, 'usage_date', true)`)
  })
}

async function seedTime(fx: Fixture, hours: string, rate: string): Promise<{ entry: string; employee: string }> {
  const { org, project } = fx
  const employee = randomUUID(), entry = randomUUID()
  await withBypassContext(async () => {
    await db.execute(sql`insert into parties(id, org_id, kind, display_name, subsidiary_id) values (${employee}, ${org.orgId}, 'employee', 'Billable worker', ${org.subsidiaryId})`)
    await db.execute(sql`insert into time_entries(id, org_id, employee_party_id, worked_on, hours, project_id, item_id, is_billable, status, billing_status, bill_rate) values (${entry}, ${org.orgId}, ${employee}, ${org.date}, ${hours}, ${project}, ${org.items.service}, true, 'approved', 'unbilled', ${rate})`)
  })
  return { entry, employee }
}

async function seedTrade(fx: Fixture, name: string): Promise<string> {
  const id = randomUUID()
  await withBypassContext(async () => {
    await db.execute(sql`insert into trades (id, org_id, name, is_active) values (${id}, ${fx.org.orgId}, ${name}, true)`)
  })
  return id
}

async function seedRole(fx: Fixture, employee: string, tradeId: string | null, jobTitle: string | null): Promise<void> {
  await withBypassContext(async () => {
    await db.execute(sql`insert into employee_roles (org_id, party_id, trade_id, job_title, is_active) values (${fx.org.orgId}, ${employee}, ${tradeId}, ${jobTitle}, true)`)
  })
}

async function invoiceLines(fx: Fixture, entry: string): Promise<{ description: string | null; amount: string }[]> {
  const { org, actor, project } = fx
  const request = await withOrgContext(org.orgId, () => createBillingRequest(org.orgId, actor, {
    projectId: project, basis: 'time_selection', selectedTimeEntryIds: [entry],
  }))
  const invoice = await withOrgContext(org.orgId, () => generateInvoiceFromBillingRequest(org.orgId, actor, request.id, null))
  const rows = await withBypassContext(() => db.execute<{ description: string | null; amount: string }>(sql`
    select description, amount::text as amount from document_lines where org_id = ${org.orgId} and document_id = ${invoice.id} order by line_number`))
  return rows.rows
}

test('a customer-targeted surcharge charges only its own customer', { skip: !DB }, async () => {
  const fx = await setup()
  try {
    await seedCard(fx, { targetType: 'customer', targetValueId: fx.org.customerId })
    const { entry } = await seedTime(fx, '10', '100')
    const lines = await invoiceLines(fx, entry)
    const surcharge = lines.filter((l) => l.description === 'Probe surcharge')
    assert.equal(surcharge.length, 1)
    assert.equal(surcharge[0]!.amount, '100.0000')
  } finally {
    await dropScratchOrg(fx.org.orgId)
  }
})

test('a surcharge targeted at another customer charges nothing', { skip: !DB }, async () => {
  const fx = await setup()
  try {
    await seedCard(fx, { targetType: 'customer', targetValueId: fx.otherCustomer })
    const { entry } = await seedTime(fx, '10', '100')
    const lines = await invoiceLines(fx, entry)
    assert.deepEqual(lines.filter((l) => l.description === 'Probe surcharge'), [])
    assert.equal(lines.length, 1)
  } finally {
    await dropScratchOrg(fx.org.orgId)
  }
})

test('a trade-targeted surcharge follows the worker, not the card', { skip: !DB }, async () => {
  const fx = await setup()
  try {
    const trade = await seedTrade(fx, 'Electrician')
    await seedCard(fx, { targetType: 'trade', targetValueId: trade })
    const spark = await seedTime(fx, '10', '100')
    await seedRole(fx, spark.employee, trade, 'Journeyman')
    const lines = await invoiceLines(fx, spark.entry)
    assert.equal(lines.filter((l) => l.description === 'Probe surcharge')[0]?.amount, '100.0000')
  } finally {
    await dropScratchOrg(fx.org.orgId)
  }
})

test('a trade-targeted surcharge ignores other trades', { skip: !DB }, async () => {
  const fx = await setup()
  try {
    const trade = await seedTrade(fx, 'Electrician')
    const otherTrade = await seedTrade(fx, 'Plumber')
    await seedCard(fx, { targetType: 'trade', targetValueId: trade })
    const wrench = await seedTime(fx, '10', '100')
    await seedRole(fx, wrench.employee, otherTrade, 'Journeyman')
    const lines = await invoiceLines(fx, wrench.entry)
    assert.deepEqual(lines.filter((l) => l.description === 'Probe surcharge'), [])
  } finally {
    await dropScratchOrg(fx.org.orgId)
  }
})

test('a labor selector charges labor-only invoices', { skip: !DB }, async () => {
  const fx = await setup()
  try {
    await seedCard(fx, { targetType: 'labor', targetValueId: null, targetValueText: 'labor' })
    const { entry } = await seedTime(fx, '10', '100')
    const lines = await invoiceLines(fx, entry)
    assert.equal(lines.filter((l) => l.description === 'Probe surcharge')[0]?.amount, '100.0000')
  } finally {
    await dropScratchOrg(fx.org.orgId)
  }
})

test('a material selector charges nothing on a labor-only invoice', { skip: !DB }, async () => {
  const fx = await setup()
  try {
    await seedCard(fx, { targetType: 'material', targetValueId: null, targetValueText: 'material' })
    const { entry } = await seedTime(fx, '10', '100')
    const lines = await invoiceLines(fx, entry)
    assert.deepEqual(lines.filter((l) => l.description === 'Probe surcharge'), [])
    assert.equal(lines.length, 1)
  } finally {
    await dropScratchOrg(fx.org.orgId)
  }
})

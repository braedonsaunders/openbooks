import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { sql } from 'drizzle-orm'
import { db, withBypassContext, withOrgTransaction } from '../platform/db.ts'
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from '../testing/fixtures.ts'
import { PortalRefusal } from './errors.ts'
import {
  consumePortalLink,
  portalTokenHash,
  requestPortalLink,
  resolvePortalSession,
  revokePortalSession,
} from './tokens.ts'
import { assertPortalDocument, assertPortalSubscription } from './scope.ts'

const DB = Boolean(process.env.OPENBOOKS_DB_URL)
const EMAIL_A = 'portal-a@example.com'
const EMAIL_B = 'portal-b@example.com'

async function enablePortal(orgId: string): Promise<void> {
  const result = await withBypassContext(() => db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb)
      || '{"customerPortal": true, "subscriptionBilling": true}'::jsonb) where id = ${orgId} returning id`))
  assert.equal(result.rows.length, 1)
}

async function setPartyEmail(orgId: string, partyId: string, email: string): Promise<void> {
  const result = await withBypassContext(() => db.execute(sql`
    update parties set email = ${email} where id = ${partyId} and org_id = ${orgId} returning id`))
  assert.equal(result.rows.length, 1)
}

async function secondCustomer(orgId: string, email: string): Promise<string> {
  const id = randomUUID()
  await withBypassContext(() => db.execute(sql`
    insert into parties (id, org_id, kind, display_name, email, is_active, custom)
    values (${id}, ${orgId}, 'customer', 'Second Customer', ${email}, true, '{}'::jsonb)`))
  return id
}

async function invoiceFor(org: ScratchOrg, partyId: string, number: string): Promise<string> {
  const id = randomUUID()
  await withBypassContext(() => db.execute(sql`
    insert into documents (id, org_id, kind, document_number, party_id, subsidiary_id, document_date,
                           currency, status, subtotal, tax_total, total, custom)
    values (${id}, ${org.orgId}, 'customer_invoice', ${number}, ${partyId}, ${org.subsidiaryId},
            ${org.date}, 'CAD', 'draft', '100', '0', '100', '{}'::jsonb)`))
  return id
}

test('portal magic links store hashes only and consume exactly once', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await enablePortal(org.orgId)
    await setPartyEmail(org.orgId, org.customerId, EMAIL_A)
    const requested = await requestPortalLink(EMAIL_A)
    assert.equal(requested.sent, true)
    assert.equal(requested.links.length, 1)
    const token = requested.links[0]!.token
    const row = (await withBypassContext(() => db.execute<{ token_hash: string }>(sql`
      select token_hash from customer_portal_links where org_id = ${org.orgId} limit 1`))).rows[0]!
    assert.equal(row.token_hash, portalTokenHash(token))
    const columns = (await withBypassContext(() => db.execute<{ column_name: string }>(sql`
      select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'customer_portal_links'
         and column_name in ('token', 'plaintext', 'secret')`))).rows
    assert.equal(columns.length, 0)
    const consumed = await consumePortalLink(token)
    assert.equal(consumed.orgId, org.orgId)
    assert.equal(consumed.partyId, org.customerId)
    const session = await resolvePortalSession(consumed.sessionToken)
    assert.deepEqual(session, { orgId: org.orgId, partyId: org.customerId, linkId: session!.linkId })
    await assert.rejects(consumePortalLink(token), (error: unknown) =>
      error instanceof PortalRefusal && error.code === 'link_consumed' && /new link/.test(error.remedy ?? ''))
  } finally { await withBypassContext(() => dropScratchOrg(org.orgId)) }
})

test('portal requests stay silent for unknown addresses', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await enablePortal(org.orgId)
    const requested = await requestPortalLink('nobody-knows@example.com')
    assert.deepEqual(requested, { sent: true, links: [] })
  } finally { await withBypassContext(() => dropScratchOrg(org.orgId)) }
})

test('portal links expire, revoke and hide behind the gate', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await enablePortal(org.orgId)
    await setPartyEmail(org.orgId, org.customerId, EMAIL_A)
    const first = (await requestPortalLink(EMAIL_A)).links[0]!.token
    await withBypassContext(() => db.execute(sql`
      update customer_portal_links
         set created_at = now() - interval '2 minutes', expires_at = now() - interval '1 minute'
       where token_hash = ${portalTokenHash(first)}`))
    await assert.rejects(consumePortalLink(first), (error: unknown) =>
      error instanceof PortalRefusal && error.code === 'link_expired' && /new link/.test(error.remedy ?? ''))
    const second = (await requestPortalLink(EMAIL_A)).links[0]!.token
    const consumed = await consumePortalLink(second)
    await revokePortalSession(consumed.sessionToken)
    assert.equal(await resolvePortalSession(consumed.sessionToken), null)
    assert.equal(await resolvePortalSession('bogus-token-value'), null)
    const third = (await requestPortalLink(EMAIL_A)).links[0]!.token
    const live = await consumePortalLink(third)
    assert.ok(await resolvePortalSession(live.sessionToken))
    await withBypassContext(() => db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{features,customerPortal}', 'false'::jsonb)
       where id = ${org.orgId}`))
    assert.equal(await resolvePortalSession(live.sessionToken), null)
  } finally { await withBypassContext(() => dropScratchOrg(org.orgId)) }
})

test('portal request caps stay silent past five links an hour', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await enablePortal(org.orgId)
    await setPartyEmail(org.orgId, org.customerId, EMAIL_A)
    for (let attempt = 0; attempt < 5; attempt++) {
      assert.equal((await requestPortalLink(EMAIL_A)).links.length, 1)
    }
    // Past the cap the endpoint still reports success but issues nothing:
    // a refusal would confirm the address belongs to a customer.
    for (let attempt = 0; attempt < 3; attempt++) {
      assert.deepEqual(await requestPortalLink(EMAIL_A), { sent: true, links: [] })
    }
    const issued = (await withBypassContext(() => db.execute<{ count: string }>(sql`
      select count(*)::text as count from customer_portal_links
       where org_id = ${org.orgId} and purpose = 'magic_link'`))).rows[0]!.count
    assert.equal(issued, '5')
  } finally { await withBypassContext(() => dropScratchOrg(org.orgId)) }
})

test('customer A cannot read customer B records', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await enablePortal(org.orgId)
    await setPartyEmail(org.orgId, org.customerId, EMAIL_A)
    const partyB = await secondCustomer(org.orgId, EMAIL_B)
    const docB = await invoiceFor(org, partyB, 'INV-B-001')
    const session = await consumePortalLink((await requestPortalLink(EMAIL_A)).links[0]!.token)
    await assert.rejects(
      withOrgTransaction(org.orgId, async () => assertPortalDocument(db, org.orgId, session.partyId, docB)),
      (error: unknown) => error instanceof PortalRefusal && error.code === 'not_found' && error.status === 404,
    )
    const planId = randomUUID()
    const subscriptionId = randomUUID()
    await withBypassContext(() => db.execute(sql`
      insert into subscription_plans (id, org_id, name, amount, interval, interval_count, income_account_id, created_by)
      values (${planId}, ${org.orgId}, 'Plan', '10.0000', 'monthly', 1, ${org.accounts.revenue}, null)`))
    await withBypassContext(() => db.execute(sql`
      insert into subscriptions (id, org_id, customer_id, plan_id, quantity, status, start_on, next_bill_on, auto_post)
      values (${subscriptionId}, ${org.orgId}, ${partyB}, ${planId}, '1', 'active', '2026-01-01', '2026-02-01', false)`))
    await assert.rejects(
      withOrgTransaction(org.orgId, async () => assertPortalSubscription(db, org.orgId, session.partyId, subscriptionId)),
      (error: unknown) => error instanceof PortalRefusal && error.code === 'not_found' && error.status === 404,
    )
  } finally { await withBypassContext(() => dropScratchOrg(org.orgId)) }
})

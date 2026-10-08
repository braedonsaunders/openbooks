import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { db, withBypassContext, withOrgContext } from '@openbooks/engine/platform/database'
import { assertDedicatedFixtureDatabase, createScratchOrg, createScratchUser, dropScratchOrg } from '@openbooks/engine/src/testing/fixtures.ts'
import { loadCustomerPulseTimeline } from './customer-pulse-timeline'

const ALL = { ar: true, crm: true, projects: false }
const AR = { ar: true, crm: false, projects: false }
const CRM = { ar: false, crm: true, projects: false }

test('customer history pages the complete scoped union, with stable ordering and exact amounts', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  await assertDedicatedFixtureDatabase()
  const org = await createScratchOrg()
  try {
    const actor = await createScratchUser(org.orgId, 'Customer History Controller', 'admin')
    const hiddenSub = randomUUID()
    const privateActivity = randomUUID()
    const hiddenActivity = randomUUID()
    const otherParty = randomUUID()
    const ids: string[] = []
    await withBypassContext(async () => {
      await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
        values (${hiddenSub}, ${org.orgId}, ${org.subsidiaryId}, 'Restricted entity', 'CAD', 'CA')`)
      await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id)
        values (${otherParty}, ${org.orgId}, 'customer', 'Other customer', ${hiddenSub})`)
      await db.execute(sql`insert into crm_account_profiles (org_id, party_id)
        values (${org.orgId}, ${org.customerId}), (${org.orgId}, ${otherParty})`)
      for (let i = 0; i < 62; i++) {
        const id = randomUUID()
        ids.push(id)
        await db.execute(sql`insert into documents
          (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date,
           currency, fx_rate, subtotal, tax_total, total, created_by, created_at)
          values (${id}, ${org.orgId}, 'customer_invoice', 'draft', ${`HISTORY-${i}`}, ${org.subsidiaryId},
            ${org.customerId}, ${org.date}, 'CAD', 1, '123456789012345.6789', 0, '123456789012345.6789', ${actor}, '2026-07-10T00:00:00Z')`)
      }
      for (let i = 0; i < 32; i++) {
        const id = randomUUID()
        ids.push(id)
        await db.execute(sql`insert into crm_activities (id, org_id, kind, status, subject, starts_at, created_at)
          values (${id}, ${org.orgId}, 'call', 'completed', ${`Collection call ${i}`}, '2026-07-10T00:00:00Z', '2026-07-10T00:00:00Z')`)
        await db.execute(sql`insert into crm_activity_links (org_id, activity_id, subject_kind, subject_id, created_by, updated_by)
          values (${org.orgId}, ${id}, 'account', ${org.customerId}, ${actor}, ${actor})`)
      }
      await db.execute(sql`insert into crm_activities (id, org_id, kind, status, subject, is_private)
        values (${privateActivity}, ${org.orgId}, 'note', 'completed', 'Private collection note', true),
               (${hiddenActivity}, ${org.orgId}, 'call', 'completed', 'Restricted linked customer', false)`)
      await db.execute(sql`insert into crm_activity_links (org_id, activity_id, subject_kind, subject_id, created_by, updated_by)
        values (${org.orgId}, ${privateActivity}, 'account', ${org.customerId}, ${actor}, ${actor}),
               (${org.orgId}, ${hiddenActivity}, 'account', ${org.customerId}, ${actor}, ${actor}),
               (${org.orgId}, ${hiddenActivity}, 'account', ${otherParty}, ${actor}, ${actor})`)
      await db.execute(sql`insert into documents
        (org_id, kind, status, document_number, subsidiary_id, party_id, document_date, currency, fx_rate, subtotal, tax_total, total)
        values (${org.orgId}, 'customer_invoice', 'draft', 'RESTRICTED-HISTORY', ${hiddenSub}, ${org.customerId}, ${org.date}, 'CAD', 1, 1, 0, 1)`)
    })
    await withOrgContext(org.orgId, async () => {
      const scope = new Set([org.subsidiaryId])
      const collected: string[] = []
      for (let page = 1; page <= 4; page++) {
        const window = await loadCustomerPulseTimeline(org.customerId, org.orgId, scope, ALL, { pulseHistoryPage: String(page) })
        assert.ok(window)
        assert.equal(window.total, 94, 'counts exclude private and inaccessible linked records')
        assert.equal(window.page, page)
        assert.equal(window.rows.length, page === 4 ? 19 : 25)
        for (const item of window.rows) {
          collected.push(item.id)
          if (item.type === 'invoice') assert.equal(item.amount, '123456789012345.6789')
        }
      }
      assert.equal(new Set(collected).size, 94, 'equal-date ties must not repeat or skip rows')
      assert.deepEqual(new Set(collected), new Set(ids), 'both source histories remain accessible beyond their former caps')
      const again = await loadCustomerPulseTimeline(org.customerId, org.orgId, scope, ALL)
      assert.deepEqual(again?.rows.map((row) => row.id), collected.slice(0, 25))
      const searched = await loadCustomerPulseTimeline(org.customerId, org.orgId, scope, ALL, { pulseHistoryQ: 'HISTORY-61' })
      assert.equal(searched?.total, 1, 'search matches the complete source before applying a page window')
      assert.equal(searched?.rows[0]?.reference, 'HISTORY-61')
      const ar = await loadCustomerPulseTimeline(org.customerId, org.orgId, scope, AR)
      assert.equal(ar?.total, 62)
      assert.ok(ar?.rows.every((row) => row.type === 'invoice'))
      const crm = await loadCustomerPulseTimeline(org.customerId, org.orgId, scope, CRM)
      assert.equal(crm?.total, 32)
      assert.ok(crm?.rows.every((row) => row.type === 'activity'))
      const deniedSearch = await loadCustomerPulseTimeline(org.customerId, org.orgId, scope, CRM, { pulseHistoryQ: 'HISTORY-61' })
      assert.equal(deniedSearch?.total, 0, 'unauthorized documents never contribute search counts')
      const outOfRange = await loadCustomerPulseTimeline(org.customerId, org.orgId, scope, ALL, { pulseHistoryPage: '100' })
      assert.equal(outOfRange?.total, 94)
      assert.deepEqual(outOfRange?.rows, [])
      assert.equal(await loadCustomerPulseTimeline(org.customerId, org.orgId, new Set(), ALL), null)
      assert.equal(await loadCustomerPulseTimeline(otherParty, org.orgId, scope, ALL), null)
      assert.equal(await loadCustomerPulseTimeline(org.customerId, randomUUID(), null, ALL), null)
      assert.equal(await loadCustomerPulseTimeline(org.customerId, org.orgId, scope, undefined), null)
      assert.deepEqual((await loadCustomerPulseTimeline(org.customerId, org.orgId, scope, { ar: false, crm: false, projects: true }))?.rows, [])
    })
  } finally { await dropScratchOrg(org.orgId) }
})

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    return next(specifier, context)
  },
})
const { sql } = await import('drizzle-orm')
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { findSamplePdfRecordId, loadPdfRecordValues } = await import('./values')

/**
 * The template-editor preview renders the org's "most recent" record. For a
 * subsidiary-restricted designer that sample must be the most recent record
 * INSIDE their scope — never a record of a legal entity hidden from them —
 * and an empty scope yields no real record at all.
 */
test('findSamplePdfRecordId honours the caller subsidiary scope', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const hidden = randomUUID()
    const visibleDoc = randomUUID()
    const hiddenDoc = randomUUID()
    const visibleEntry = randomUUID()
    const hiddenEntry = randomUUID()
    await withBypassContext(async () => {
      await db.execute(sql`insert into subsidiaries(id, org_id, parent_id, name, base_currency, country)
        values (${hidden}, ${org.orgId}, ${org.subsidiaryId}, 'Hidden', 'CAD', 'CA')`)

      for (const [id, sub, label, createdAt] of [
        [visibleDoc, org.subsidiaryId, 'Visible', '2026-07-01T00:00:00Z'],
        [hiddenDoc, hidden, 'Hidden', '2026-07-02T00:00:00Z'],
      ] as const) {
        await db.execute(sql`insert into documents(id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date, currency, fx_rate, created_at)
          values (${id}, ${org.orgId}, 'customer_invoice', 'draft', ${label}, ${sub}, ${org.customerId}, ${org.date}, 'CAD', 1, ${createdAt}::timestamptz)`)
      }

      for (const [id, sub, createdAt] of [
        [visibleEntry, org.subsidiaryId, '2026-07-01T00:00:00Z'],
        [hiddenEntry, hidden, '2026-07-02T00:00:00Z'],
      ] as const) {
        await db.execute(sql`insert into journal_entries(id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin, created_at)
          values (${id}, ${org.orgId}, ${org.bookId}, ${sub}, ${id}, ${org.date}, ${org.periodId}, 'draft', 'manual', ${createdAt}::timestamptz)`)
      }
    })
    const sample = (kind: string, scope: Set<string> | null) =>
      withOrgContext(org.orgId, () => findSamplePdfRecordId(kind, org.orgId, scope))

    // Unrestricted: the org-wide latest record.
    assert.equal(await sample('customer_invoice', null), hiddenDoc)
    assert.equal(await sample('journal_entry', null), hiddenEntry)

    // Restricted to the visible entity: the latest record of THAT entity.
    const scope = new Set([org.subsidiaryId])
    assert.equal(await sample('customer_invoice', scope), visibleDoc)
    assert.equal(await sample('journal_entry', scope), visibleEntry)

    // Empty scope: nothing real is ever sampled.
    assert.equal(await sample('customer_invoice', new Set()), null)
    assert.equal(await sample('journal_entry', new Set()), null)

    // This fixture contains no payroll records; neither payroll sample exists.
    assert.equal(await sample('pay_stub', scope), null)
    assert.equal(await sample('payroll_cheque', scope), null)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

/**
 * The preview samples a record in scope and THEN loads it: the subsidiary
 * predicate must be enforced in the load itself, because a record moved to
 * a hidden legal entity between the two awaits must read as not found —
 * never render. Naming the id directly with an excluding scope is the same
 * hole, so the load refuses that too.
 */
test('loadPdfRecordValues enforces the caller scope in the load itself', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const hidden = randomUUID()
    const visibleDoc = randomUUID()
    const hiddenDoc = randomUUID()
    await withBypassContext(async () => {
      await db.execute(sql`insert into subsidiaries(id, org_id, parent_id, name, base_currency, country)
        values (${hidden}, ${org.orgId}, ${org.subsidiaryId}, 'Hidden', 'CAD', 'CA')`)
      for (const [id, sub, label] of [
        [visibleDoc, org.subsidiaryId, 'Visible'],
        [hiddenDoc, hidden, 'Hidden'],
      ] as const) {
        await db.execute(sql`insert into documents(id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date, currency, fx_rate)
          values (${id}, ${org.orgId}, 'customer_invoice', 'draft', ${label}, ${sub}, ${org.customerId}, ${org.date}, 'CAD', 1)`)
      }
    })
    const load = (id: string, scope: Set<string> | null) =>
      withOrgContext(org.orgId, () => loadPdfRecordValues('customer_invoice', org.orgId, id, scope))

    // The TOCTOU case: the id is known (sampled while visible, or named
    // directly) but the scope excludes its subsidiary — the load refuses.
    assert.equal(await load(hiddenDoc, new Set([org.subsidiaryId])), null)
    // The scope that owns it, and the unconstrained system context, load it.
    assert.ok(await load(hiddenDoc, new Set([hidden])))
    assert.ok(await load(hiddenDoc, null))
    assert.ok(await load(visibleDoc, new Set([org.subsidiaryId])))
    // An empty scope loads nothing at all.
    assert.equal(await load(visibleDoc, new Set()), null)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

/**
 * Field-ticket hours print at the exact stored quantity: 0.04 + 0.10 + 0.20
 * prints "0.34", never "0.3" rounded from a float and never "0.0" while the
 * billed amount beside it is nonzero. The day cells reconcile the same way.
 */
test('field-ticket hours print exact decimals that reconcile to the billed amount', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
  const { seedFlowActors } = await import('@openbooks/engine/src/testing/fixtures.ts')
  const { createFieldTicket } = await import('../field-tickets')
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,fieldTickets}', 'true'::jsonb, true) where id = ${org.orgId}`)
      const actor = (await seedFlowActors(org.orgId)).adminId
      const projectId = randomUUID()
      await db.execute(sql`insert into projects
        (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
        values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'HRS-1', 'Hours job', ${org.customerId}, 'active', true, '{}'::jsonb)`)
      const created = await createFieldTicket(org.orgId, actor, { projectId, date: org.date })
      const employee = randomUUID()
      await db.execute(sql`insert into parties(id, org_id, kind, display_name, subsidiary_id)
        values (${employee}, ${org.orgId}, 'employee', 'Exact Worker', ${org.subsidiaryId})`)
      const timeType = randomUUID()
      await db.execute(sql`insert into time_types(id, org_id, name) values (${timeType}, ${org.orgId}, 'Regular')`)
      // 0.34 h at $250/h bills $85.00: every printed figure must reconcile.
      for (const hours of ['0.0400', '0.1000', '0.2000']) {
        await db.execute(sql`insert into time_entries
          (org_id, employee_party_id, time_type_id, worked_on, hours, field_ticket_id, bill_rate, is_billable, status)
          values (${org.orgId}, ${employee}, ${timeType}, ${org.date}, ${hours}, ${created.id}, '250.0000', true, 'approved')`)
      }

      const record = await loadPdfRecordValues('field_ticket', org.orgId, created.id, null)
      const lines = record?.values.crew as { reg_hours: string; total_hours: string; amount: string }[]
      assert.equal(lines?.length, 1, 'one crew row for the single employee')
      assert.equal(lines[0]!.reg_hours, '0.34')
      assert.equal(lines[0]!.total_hours, '0.34')
      assert.ok(lines[0]!.amount.includes('85'), `billed $85.00 beside 0.34 h, got ${lines[0]!.amount}`)
      const dayCells = Object.entries(lines[0] ?? {}).filter(([k]) => /^day\d+_reg$/.test(k)).map(([, v]) => v)
      assert.ok(dayCells.includes('0.34'), `a day cell carries the exact 0.34 h, got ${JSON.stringify(dayCells)}`)
    } finally {
      await dropScratchOrg(org.orgId)
    }
  })
})

/**
 * The field-ticket template catalog advertises a party address merge field.
 * It must print the customer's default billing address like every sibling
 * record type — never a silent blank.
 */
test('field-ticket merge values populate the customer party address', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
  const { seedFlowActors } = await import('@openbooks/engine/src/testing/fixtures.ts')
  const { createFieldTicket } = await import('../field-tickets')
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,fieldTickets}', 'true'::jsonb, true) where id = ${org.orgId}`)
      await db.execute(sql`insert into addresses
        (id, org_id, party_id, label, line1, city, region, postal_code, country, is_default_billing)
        values (${randomUUID()}, ${org.orgId}, ${org.customerId}, 'HQ', '400 King St W', 'Toronto', 'ON', 'M5V 1K2', 'CA', true)`)
      const actor = (await seedFlowActors(org.orgId)).adminId
      const projectId = randomUUID()
      await db.execute(sql`insert into projects
        (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
        values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'ADDR-1', 'Address job', ${org.customerId}, 'active', true, '{}'::jsonb)`)
      const created = await createFieldTicket(org.orgId, actor, { projectId })
      const record = await loadPdfRecordValues('field_ticket', org.orgId, created.id, null)
      assert.equal(record?.values.party_address, '400 King St W, Toronto, ON, M5V 1K2, CA')
    } finally {
      await dropScratchOrg(org.orgId)
    }
  })
})

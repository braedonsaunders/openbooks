import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import type { CustomerPulseSections } from './customer-pulse.ts'
const { sql } = await import('drizzle-orm')
const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { postDocument } = await import('@openbooks/engine/src/ledger/posting-document.ts')
const { loadCustomerPulse } = await import('./customer-pulse.ts')

const FULL: CustomerPulseSections = { ar: true, crm: true, projects: true }
const AR_ONLY: CustomerPulseSections = { ar: true, crm: false, projects: false }

/**
 * The pulse is a combined payload: each section needs its own read. A
 * CRM-only caller gets pipeline/activity but no AR figures (balances,
 * credit controls, payment history); an AR-only caller gets receivables
 * but no pipeline/activity; omitted sections are absent — never zeroed.
 */
test('customer pulse gates each section by its own permission', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    const actor = await withBypass(() => createScratchUser(scratch.orgId, 'Pulse Controller', 'admin'))
    const invoiceId = randomUUID()
    const statusId = randomUUID()
    const oppId = randomUUID()
    const activityId = randomUUID()
    const projectId = randomUUID()
    await withBypass(async () => {
      await db.execute(sql`
        insert into customer_roles (org_id, party_id, credit_limit, currency)
        values (${scratch.orgId}, ${scratch.customerId}, 10000, 'CAD')`)
      await db.execute(sql`insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date,
         currency, fx_rate, subtotal, tax_total, total, created_by)
        values (${invoiceId}, ${scratch.orgId}, 'customer_invoice', 'draft', ${invoiceId}, ${scratch.subsidiaryId},
          ${scratch.customerId}, ${scratch.date}, 'CAD', '1', 1000, 0, 1000, ${actor})`)
      await db.execute(sql`insert into document_lines
        (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
        values (${scratch.orgId}, ${invoiceId}, 1, ${scratch.accounts.revenue}, 1, 1000, 1000, 0, 1000)`)
      await db.execute(sql`update documents set status = 'approved' where id = ${invoiceId}`)
      await postDocument(invoiceId, { control: { ar: scratch.accounts.ar, ap: scratch.accounts.ap, bank: scratch.accounts.bank } })
      // Hold AFTER posting: the kernel refuses new postings to held
      // customers, and the pulse must still surface the hold itself.
      await db.execute(sql`
        update customer_roles set is_on_hold = true, hold_reason = 'limit review hold',
               held_at = now(), held_by = ${actor}
         where org_id = ${scratch.orgId} and party_id = ${scratch.customerId}`)
      await db.execute(sql`
        insert into crm_opportunity_statuses (id, org_id, key, name, sequence, probability, is_closed, is_won, is_active)
        values (${statusId}, ${scratch.orgId}, 'negotiation', 'Negotiation', 10, 60, false, false, true)`)
      await db.execute(sql`
        insert into crm_opportunities (id, org_id, opportunity_number, title, party_id, status_id,
               forecast_category, probability, currency, projected_amount, weighted_amount, is_active)
        values (${oppId}, ${scratch.orgId}, 'OPP-1', 'Tower Fit-Out', ${scratch.customerId}, ${statusId},
               'most_likely', 60, 'CAD', '5000', '3000', true)`)
      await db.execute(sql`
        insert into crm_activities (id, org_id, kind, status, subject, priority)
        values (${activityId}, ${scratch.orgId}, 'call', 'completed', 'discovery call', 'high')`)
      await db.execute(sql`
        insert into crm_activity_links (org_id, activity_id, subject_kind, subject_id, created_by, updated_by)
        values (${scratch.orgId}, ${activityId}, 'account', ${scratch.customerId}, ${actor}, ${actor})`)
      await db.execute(sql`
        insert into projects (id, org_id, name, customer_id, subsidiary_id, status, contract_value, is_active)
        values (${projectId}, ${scratch.orgId}, 'Tower', ${scratch.customerId}, ${scratch.subsidiaryId}, 'active', 20000, true)`)
    })

    await withOrgContext(scratch.orgId, async () => {
      const full = await loadCustomerPulse(scratch.customerId, scratch.orgId, null, FULL)
      assert.ok(full)
      assert.equal(full.aging?.totalOpen, '1000.0000')
      assert.equal(full.credit?.creditLimit, '10000.0000')
      assert.equal(full.pipeline?.projectedPipeline, '5000.0000')
      assert.equal(full.projects?.totalCount, 1)
      assert.equal(full.party.creditLimit, '10000.0000')
      assert.equal(full.party.isOnHold, true)
      assert.ok(full.timeline.some((t) => t.type === 'activity'))
      assert.ok(full.timeline.some((t) => t.type === 'invoice'))

      // CRM-only: pipeline/activity, no AR figures anywhere.
      const crm = await loadCustomerPulse(scratch.customerId, scratch.orgId, null, { ar: false, crm: true, projects: false })
      assert.ok(crm)
      assert.equal(crm.pipeline?.projectedPipeline, '5000.0000')
      assert.equal(crm.aging, undefined)
      assert.equal(crm.credit, undefined)
      assert.equal(crm.paymentMetrics, undefined)
      assert.equal(crm.projects, undefined)
      assert.ok(!('creditLimit' in crm.party))
      assert.ok(!('isOnHold' in crm.party))
      assert.ok(!('holdReason' in crm.party))
      assert.ok(!('paymentTermsName' in crm.party))
      assert.ok(crm.timeline.length > 0)
      assert.ok(crm.timeline.every((t) => t.type === 'activity'))

      // AR-only: receivables, no pipeline/activity.
      const ar = await loadCustomerPulse(scratch.customerId, scratch.orgId, null, { ar: true, crm: false, projects: false })
      assert.ok(ar)
      assert.equal(ar.aging?.totalOpen, '1000.0000')
      assert.equal(ar.credit?.creditLimit, '10000.0000')
      assert.equal(ar.pipeline, undefined)
      assert.equal(ar.projects, undefined)
      assert.ok(ar.timeline.length > 0)
      assert.ok(ar.timeline.every((t) => t.type !== 'activity'))

      // Projects-only: rollup and identity, nothing else.
      const prj = await loadCustomerPulse(scratch.customerId, scratch.orgId, null, { ar: false, crm: false, projects: true })
      assert.ok(prj)
      assert.equal(prj.projects?.totalCount, 1)
      assert.equal(prj.aging, undefined)
      assert.equal(prj.pipeline, undefined)
      assert.deepEqual(prj.timeline, [])

      // No sections: no access, no payload.
      assert.equal(await loadCustomerPulse(scratch.customerId, scratch.orgId, null, { ar: false, crm: false, projects: false }), null)
      assert.equal(await loadCustomerPulse(scratch.customerId, scratch.orgId, null, undefined), null)
    })
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})

/**
 * One explicit presentation currency — the org base — for the whole pulse.
 * A CAD org with mixed-currency orders labels CAD (never an invented USD),
 * translates every monetary input through the house FX path at a stated
 * rate date, and refuses by name when a rate is missing instead of mixing
 * currencies into the headroom.
 */
test('customer pulse presents in the org base and translates mixed currencies', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    const actor = await withBypass(() => createScratchUser(scratch.orgId, 'Pulse Currency', 'admin'))
    const invoiceId = randomUUID()
    const orderId = randomUUID()
    const statusId = randomUUID()
    const oppId = randomUUID()
    const bareParty = randomUUID()
    await withBypass(async () => {
      const orgRow = (await db.execute(
        sql`select base_currency from orgs where id = ${scratch.orgId}`,
      )).rows[0] as { base_currency: string } | undefined
      assert.equal(orgRow?.base_currency, 'CAD')
      await db.execute(sql`
        insert into customer_roles (org_id, party_id, credit_limit, currency)
        values (${scratch.orgId}, ${scratch.customerId}, 10000, 'CAD')`)
      await db.execute(sql`insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date,
         currency, fx_rate, subtotal, tax_total, total, created_by)
        values (${invoiceId}, ${scratch.orgId}, 'customer_invoice', 'draft', ${invoiceId}, ${scratch.subsidiaryId},
          ${scratch.customerId}, ${scratch.date}, 'CAD', '1', 1000, 0, 1000, ${actor})`)
      await db.execute(sql`insert into document_lines
        (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
        values (${scratch.orgId}, ${invoiceId}, 1, ${scratch.accounts.revenue}, 1, 1000, 1000, 0, 1000)`)
      await db.execute(sql`update documents set status = 'approved' where id = ${invoiceId}`)
      await postDocument(invoiceId, { control: { ar: scratch.accounts.ar, ap: scratch.accounts.ap, bank: scratch.accounts.bank } })
      // USD order: 100 USD at 1.35 lands as 135 CAD, not 100 raw.
      await db.execute(sql`insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date,
         currency, fx_rate, subtotal, tax_total, total, created_by)
        values (${orderId}, ${scratch.orgId}, 'sales_order', 'approved', ${orderId}, ${scratch.subsidiaryId},
          ${scratch.customerId}, ${scratch.date}, 'USD', '1.35', 100, 0, 100, ${actor})`)
      await db.execute(sql`
        insert into crm_opportunity_statuses (id, org_id, key, name, sequence, probability, is_closed, is_won, is_active)
        values (${statusId}, ${scratch.orgId}, 'negotiation', 'Negotiation', 10, 60, false, false, true)`)
      await db.execute(sql`
        insert into crm_opportunities (id, org_id, opportunity_number, title, party_id, status_id,
               forecast_category, probability, currency, projected_amount, weighted_amount,
               expected_close_date, is_active)
        values (${oppId}, ${scratch.orgId}, 'OPP-FX', 'Cross-border deal', ${scratch.customerId}, ${statusId},
               'most_likely', 60, 'USD', '1000', '600', ${scratch.date}, true)`)
      await db.execute(sql`
        insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, created_by)
        values (${scratch.orgId}, 'USD', 'CAD', ${scratch.date}, 'spot', '1.30', ${actor})`)
      // A customer with no role row at all: still the org base, never USD.
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${bareParty}, ${scratch.orgId}, 'customer', 'Bare Customer', true, '{}'::jsonb)`)
    })

    await withOrgContext(scratch.orgId, async () => {
      const pulse = await loadCustomerPulse(scratch.customerId, scratch.orgId, null, FULL)
      assert.ok(pulse)
      assert.equal(pulse.party.currency, 'CAD')
      assert.equal(pulse.credit?.unbilledOrdersBalance, '135.0000')
      assert.equal(pulse.credit?.openArBalance, '1000.0000')
      assert.equal(pulse.credit?.remainingCredit, '8865.0000')
      assert.equal(pulse.pipeline?.projectedPipeline, '1300.0000')
      assert.equal(pulse.pipeline?.weightedPipeline, '780.0000')

      const bare = await loadCustomerPulse(bareParty, scratch.orgId, null, FULL)
      assert.ok(bare)
      assert.equal(bare.party.currency, 'CAD')
    })

    // Drop the rate: the pulse must refuse by name, not mix currencies.
    await withBypass(async () => {
      await db.execute(sql`delete from fx_rates where org_id = ${scratch.orgId}`)
    })
    await withOrgContext(scratch.orgId, async () => {
      await assert.rejects(
        loadCustomerPulse(scratch.customerId, scratch.orgId, null, FULL),
        /no spot rate for USD→CAD/,
      )
    })
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})

/**
 * Ledger money aggregates as exact decimal strings through the pulse — never
 * floats. 0.10 + 0.20 is "0.3000" (floats give 0.30000000000000004), amounts
 * above 2^53 keep their cents, and credit headroom subtracts exactly.
 */
test('customer pulse keeps money exact through aggregation and JSON', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    const actor = await withBypass(() => createScratchUser(scratch.orgId, 'Pulse Precision', 'admin'))
    const bigParty = randomUUID()
    const bigEntry = randomUUID()
    const bigDoc = randomUUID()
    // Large magnitude with exact cents: numeric(19,4) storage and its monthly
    // rollups cap below 10^15, so the test stays inside the domain — but
    // 123456789012345.6789 carries 19 significant digits, past f64's ~16, so
    // parseFloat loses the trailing cents while decimal text keeps them.
    const HUGE = '123456789012345.6789'
    const NEG_HUGE = '-123456789012345.6789'
    await withBypass(async () => {
      await db.execute(sql`
        insert into customer_roles (org_id, party_id, credit_limit, currency)
        values (${scratch.orgId}, ${scratch.customerId}, 10000, 'CAD')`)
      for (const [id, amount] of [[randomUUID(), '0.10'], [randomUUID(), '0.20']] as const) {
        await db.execute(sql`insert into documents
          (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date,
           currency, fx_rate, subtotal, tax_total, total, created_by)
          values (${id}, ${scratch.orgId}, 'customer_invoice', 'draft', ${id}, ${scratch.subsidiaryId},
            ${scratch.customerId}, ${scratch.date}, 'CAD', '1', ${amount}, 0, ${amount}, ${actor})`)
        await db.execute(sql`insert into document_lines
          (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
          values (${scratch.orgId}, ${id}, 1, ${scratch.accounts.revenue}, 1, ${amount}, ${amount}, 0, ${amount})`)
        await db.execute(sql`update documents set status = 'approved' where id = ${id}`)
        await postDocument(id, { control: { ar: scratch.accounts.ar, ap: scratch.accounts.ap, bank: scratch.accounts.bank } })
      }
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${bigParty}, ${scratch.orgId}, 'customer', 'Huge Customer', true, '{}'::jsonb)`)
      await db.execute(sql`insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
        values (${bigEntry}, ${scratch.orgId}, ${scratch.bookId}, ${scratch.subsidiaryId},
          'HUGE-1', ${scratch.date}, ${scratch.periodId}, 'HUGE-1', 'draft', 'manual')`)
      await db.execute(sql`insert into journal_lines
        (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, party_id, is_open_item, memo)
        values (${scratch.orgId}, ${bigEntry}, 1, ${scratch.accounts.ar}, ${scratch.subsidiaryId},
          ${HUGE}, 'CAD', ${HUGE}, '1', ${bigParty}, true, 'HUGE-1'),
          (${scratch.orgId}, ${bigEntry}, 2, ${scratch.accounts.revenue}, ${scratch.subsidiaryId},
          ${NEG_HUGE}, 'CAD', ${NEG_HUGE}, '1', null, false, 'HUGE-1')`)
      // openItems joins entries to documents through the source link; link the
      // draft entry before posting (posted entries are immutable).
      await db.execute(sql`insert into documents
        (id, org_id, kind, document_number, document_date, posting_date, currency, fx_rate,
         subtotal, tax_total, total, party_id, status, posted_entry_id, posting_period_id, open_balance, subsidiary_id)
        values (${bigDoc}, ${scratch.orgId}, 'customer_invoice', 'HUGE-1', ${scratch.date}, ${scratch.date},
          'CAD', '1', ${HUGE}, '0.0000', ${HUGE}, ${bigParty}, 'draft', ${bigEntry}, ${scratch.periodId}, ${HUGE}, ${scratch.subsidiaryId})`)
      await db.execute(sql`update journal_entries set source_document_id = ${bigDoc} where id = ${bigEntry}`)
      // Lines of a posted entry are immutable: post the entry after its lines.
      await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${bigEntry}`)
      await db.execute(sql`update documents set status = 'posted' where id = ${bigDoc}`)
    })

    await withOrgContext(scratch.orgId, async () => {
      const small = await loadCustomerPulse(scratch.customerId, scratch.orgId, null, AR_ONLY)
      assert.ok(small?.aging)
      assert.equal(small.aging.totalOpen, '0.3000')
      assert.equal(small.aging.current, '0.3000')
      assert.equal(small.credit?.openArBalance, '0.3000')
      assert.equal(small.credit?.remainingCredit, '9999.7000')
      assert.equal(small.party.creditLimit, '10000.0000')

      const big = await loadCustomerPulse(bigParty, scratch.orgId, null, AR_ONLY)
      assert.ok(big?.aging)
      assert.equal(big.aging.totalOpen, HUGE)
      assert.equal(big.credit?.openArBalance, HUGE)
    })
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})

/**
 * Project cost must come from the governed project financial reader — the
 * same measures the project cockpit Financials tab renders — never an
 * invented zero with a fabricated 100% margin. A project billed 100 with
 * 80 of posted costs reports cost 80, profit 20, margin 20%.
 */
test('customer pulse project rollup reports true cost and margin', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    const actor = await withBypass(() => createScratchUser(scratch.orgId, 'Pulse Projects', 'admin'))
    const projectId = randomUUID()
    const billId = randomUUID()
    const invoiceId = randomUUID()
    await withBypass(async () => {
      await db.execute(sql`
        insert into projects (id, org_id, name, customer_id, subsidiary_id, status, contract_value, is_active)
        values (${projectId}, ${scratch.orgId}, 'Tower', ${scratch.customerId}, ${scratch.subsidiaryId}, 'active', 1000, true)`)
      // Posted vendor cost tagged to the project.
      await db.execute(sql`insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date,
         currency, fx_rate, subtotal, tax_total, total, created_by)
        values (${billId}, ${scratch.orgId}, 'vendor_bill', 'draft', ${billId}, ${scratch.subsidiaryId},
          ${scratch.vendorId}, ${scratch.date}, 'CAD', '1', 80, 0, 80, ${actor})`)
      await db.execute(sql`insert into document_lines
        (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount, project_id)
        values (${scratch.orgId}, ${billId}, 1, ${scratch.accounts.cogs}, 1, 80, 80, 0, 80, ${projectId})`)
      await db.execute(sql`update documents set status = 'approved' where id = ${billId}`)
      await postDocument(billId, { control: { ar: scratch.accounts.ar, ap: scratch.accounts.ap, bank: scratch.accounts.bank } })
      // Posted customer billing tagged to the project.
      await db.execute(sql`insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date,
         currency, fx_rate, subtotal, tax_total, total, created_by)
        values (${invoiceId}, ${scratch.orgId}, 'customer_invoice', 'draft', ${invoiceId}, ${scratch.subsidiaryId},
          ${scratch.customerId}, ${scratch.date}, 'CAD', '1', 100, 0, 100, ${actor})`)
      await db.execute(sql`insert into document_lines
        (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount, project_id)
        values (${scratch.orgId}, ${invoiceId}, 1, ${scratch.accounts.revenue}, 1, 100, 100, 0, 100, ${projectId})`)
      await db.execute(sql`update documents set status = 'approved' where id = ${invoiceId}`)
      await postDocument(invoiceId, { control: { ar: scratch.accounts.ar, ap: scratch.accounts.ap, bank: scratch.accounts.bank } })
    })

    await withOrgContext(scratch.orgId, async () => {
      const pulse = await loadCustomerPulse(scratch.customerId, scratch.orgId, null, FULL)
      assert.ok(pulse?.projects)
      assert.equal(pulse.projects.totalCount, 1)
      assert.equal(pulse.projects.totalContractValue, '1000.0000')
      assert.equal(pulse.projects.totalBilled, '100.0000')
      assert.equal(pulse.projects.totalCost, '80.0000')
      assert.equal(pulse.projects.grossProfit, '20.0000')
      assert.equal(pulse.projects.grossMarginPercent, 20)
    })
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})


const customerListCases = [
  { label: "customer list crm off", register: async () => {
        const assert: typeof import('node:assert/strict') = (await import('node:assert/strict')).default;
        const test = (await import('node:test')).default;
        const { stubModules } = await import('../testing/stub-modules.ts');
        // /entities/customers crashes for orgs with CRM off. The list's
        // status-facet query groups by the status expression, which is the constant
        // 'customer' when CRM is off — `group by 'customer'` is a Postgres 42601, so
        // the whole page throws. CRM-on orgs group by a real column and never notice.
        stubModules({ intl: true, navigation: false, authz: false, features: false });

        const { sql } = await import('drizzle-orm')
        const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
        const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
        const { EntityListView } = await import('../components/entity-list-view')
        const DB = !!process.env.OPENBOOKS_DB_URL

        async function fixture(crm: boolean, action: (orgId: string, userId: string) => Promise<void>) {
          const org = await withBypassContext(() => createScratchOrg())
          try {
            const userId = await withBypassContext(() => createScratchUser(org.orgId, 'List reader', 'reviewer'))
            await withBypassContext(async () => {
              await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id = ${org.orgId} and key = 'reviewer'`)
              await db.execute(sql`update orgs set settings = settings || ${JSON.stringify({ features: { crm } })}::jsonb where id = ${org.orgId}`)
            })
            await action(org.orgId, userId)
          } finally {
            await dropScratchOrg(org.orgId)
          }
        }

        test('customer list renders with CRM off (constant status facet)', { skip: !DB }, async () => {
          await fixture(false, async (orgId, userId) => {
            const element = await withOrgContext(orgId, () => EntityListView({ recordType: 'customer', orgId, userId, canManage: true, sp: {} }))
            assert.ok(element, 'the list must render instead of throwing 42601')
          })
        })

        test('customer list still renders with CRM on (grouped status facet)', { skip: !DB }, async () => {
          await fixture(true, async (orgId, userId) => {
            const element = await withOrgContext(orgId, () => EntityListView({ recordType: 'customer', orgId, userId, canManage: true, sp: {} }))
            assert.ok(element, 'the list must render')
          })
        })
  } },
] as const;

for (const row of customerListCases) await row.register();

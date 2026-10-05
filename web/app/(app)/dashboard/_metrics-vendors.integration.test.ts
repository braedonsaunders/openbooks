import assert from 'node:assert/strict'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { db, withBypass, withOrgContext } from '@openbooks/engine/src/platform/db.ts'
import { createScratchOrg, dropScratchOrg } from '@openbooks/engine/src/testing/fixtures.ts'
import { vendorData } from '@/lib/analytics/vendor-data.ts'
import { spendVelocityData } from '@/lib/analytics/spend-velocity-data.ts'
import { loadVendorWidgetMetrics } from './_metrics-vendors.ts'
import type { DashboardWidgetContext } from './_metrics-context.ts'

const env = process.env as Record<string, string | undefined>
const DB = env.OPENBOOKS_DB_URL ?? ''

/**
 * A dashboard widget shows exactly what its Analytics dashboard shows: the
 * widget reader and the dashboard loader read the same figures through the
 * same loader. Any divergence between the two is a second source of truth.
 */
test('vendor widget metrics equal the vendor dashboard figures', { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg())
  try {
    const vend = randomUUID()
    await withBypass(async () => {
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
        values (${vend}, ${org.orgId}, 'vendor', 'Widget Vendor', ${org.subsidiaryId}, true, '{}'::jsonb)`)
      await db.execute(sql`
        insert into vendor_roles (id, org_id, party_id)
        values (${randomUUID()}, ${org.orgId}, ${vend})`)
      const docId = randomUUID()
      const entryId = randomUUID()
      await db.execute(sql`
        insert into documents (id, org_id, kind, document_number, party_id, subsidiary_id, document_date, posting_date, currency, fx_rate, status, subtotal, tax_total, total, open_balance)
        values (${docId}, ${org.orgId}, 'vendor_bill', 'WIDGET-BILL', ${vend}, ${org.subsidiaryId}, '2026-07-10', '2026-07-10', 'CAD', '1', 'draft', '200', 0, '200', '200')`)
      await db.execute(sql`
        insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin, source_document_id)
        values (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'WIDGET-BILL', '2026-07-10', ${org.periodId}, 'draft', 'manual', ${docId})`)
      await db.execute(sql`
        insert into journal_lines (id, org_id, entry_id, line_number, account_id, subsidiary_id, party_id, amount, currency, txn_amount, fx_rate)
        values (${randomUUID()}, ${org.orgId}, ${entryId}, 1, ${org.accounts.cogs}, ${org.subsidiaryId}, ${vend}, '200', 'CAD', '200', '1'),
               (${randomUUID()}, ${org.orgId}, ${entryId}, 2, ${org.accounts.bank}, ${org.subsidiaryId}, ${vend}, '-200', 'CAD', '-200', '1')`)
      await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entryId}`)
      await db.execute(sql`update documents set status = 'posted', posted_entry_id = ${entryId}, posting_period_id = ${org.periodId} where id = ${docId}`)
    })
    const window = { from: '2026-07-01', to: '2026-07-31', label: 'July 2026' }
    const ctx = {
      orgId: org.orgId,
      allowedSubsidiaryIds: null,
      period: async () => window,
    } as unknown as DashboardWidgetContext
    const dashboard = await withOrgContext(org.orgId, () => vendorData(window, org.orgId, null))
    const widgets = await withOrgContext(org.orgId, () => loadVendorWidgetMetrics(ctx, () => true))
    assert.equal(widgets.vendorPeriodLabel, dashboard.period.label)
    assert.deepEqual(widgets.concentrationHhi, { available: true, value: dashboard.totals.hhiScaled })
    assert.deepEqual(widgets.concentrationTop5Share, { available: true, value: dashboard.totals.top5SharePct })
    assert.deepEqual(widgets.vendorLateSpend, { available: true, value: dashboard.totals.lateSpend })
    if (dashboard.totals.onTimePct === null) {
      assert.equal(widgets.vendorOnTimeRate?.available, false)
      assert.ok(
        (widgets.vendorOnTimeRate as { available: false; reason: string }).reason.length > 0,
        'an unavailable rate must say why',
      )
    } else {
      assert.deepEqual(widgets.vendorOnTimeRate, { available: true, value: dashboard.totals.onTimePct })
    }
    const spendDashboard = await withOrgContext(org.orgId, () => spendVelocityData(org.orgId, window, null))
    const spendWidgets = await withOrgContext(org.orgId, () =>
      loadVendorWidgetMetrics(ctx, (...fields) => fields.includes('spendOpenAlerts') || fields.includes('spendSavingsPotential')),
    )
    assert.deepEqual(spendWidgets.spendSavingsPotential, { available: true, value: spendDashboard.summary.savingsPotential })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

/**
 * Concentration of nothing is not diversification: with no vendor spend the
 * concentration tile stays unavailable by name instead of reading green
 * with HHI 0 and a 0% top-5 share.
 */
test('vendor concentration widgets refuse by name with no vendor spend', { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg())
  try {
    const window = { from: '2026-07-01', to: '2026-07-31', label: 'July 2026' }
    const ctx = {
      orgId: org.orgId,
      allowedSubsidiaryIds: null,
      period: async () => window,
    } as unknown as DashboardWidgetContext
    const widgets = await withOrgContext(org.orgId, () => loadVendorWidgetMetrics(ctx, () => true))
    assert.equal(widgets.concentrationHhi?.available, false)
    assert.equal(widgets.concentrationTop5Share?.available, false)
    assert.ok(
      ((widgets.concentrationHhi ?? {}) as { reason?: string }).reason?.length,
      'an unavailable concentration must say why',
    )
    assert.equal(widgets.concentrationBand, null)
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

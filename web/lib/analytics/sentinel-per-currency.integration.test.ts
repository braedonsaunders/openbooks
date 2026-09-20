import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({
  resolve(specifier, _context, next) {
    if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    return next(specifier)
  },
})

const { sql } = await import('drizzle-orm')
const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { sentinelData } = await import('./sentinel-data')

type Authz = Parameters<typeof sentinelData>[2]
type Data = Awaited<ReturnType<typeof sentinelData>>

const P = { from: '2026-07-01', to: '2026-07-31', label: 'July 2026' }

interface SeedDoc { num: string; currency: string; fx: string; total: string; date: string; ref: string | null }

async function seedVendorBills(orgId: string, subsidiaryId: string, name: string, docs: SeedDoc[]) {
  const vendorId = randomUUID()
  await withBypass(async () => {
    await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
      values (${vendorId}, ${orgId}, 'vendor', ${name}, ${subsidiaryId}, true, '{}'::jsonb)`)
    for (const d of docs) {
      await db.execute(sql`insert into documents (id, org_id, kind, document_number, party_id, subsidiary_id,
          document_date, posting_date, currency, fx_rate, status, subtotal, tax_total, total, open_balance, reference_number)
        values (${randomUUID()}, ${orgId}, 'vendor_bill', ${d.num}, ${vendorId}, ${subsidiaryId},
          ${d.date}, ${d.date}, ${d.currency}, ${d.fx}, 'draft', ${d.total}, 0, ${d.total}, ${d.total}, ${d.ref})`)
    }
  })
  return vendorId
}

async function runSentinel(orgId: string): Promise<Data> {
  const authz = {
    user: { orgId, id: randomUUID() },
    permissions: new Set(['*']),
    allowedSubsidiaryIds: null,
  } as unknown as Authz
  return withOrgContext(orgId, () => sentinelData(orgId, P, authz))
}

/**
 * RSF runs per document currency: a USD 1500 bill against a USD 100 baseline
 * flags (15x), while a CAD 1500 bill with no CAD history must not borrow the
 * USD baseline — the mixed baseline used to flag it as a false positive.
 */
test('sentinel RSF baselines never cross document currencies', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  try {
    const flatBaseline = (prefix: string) =>
      ['100', '100', '100', '100', '100', '100'].map((total, i) => ({
        num: `${prefix}-BASE-${i}`, currency: 'USD', fx: '1.35', total, date: '2026-06-15', ref: `${prefix}-B${i}`,
      }))
    await seedVendorBills(org.orgId, org.subsidiaryId, 'RSF Control Vendor', [
      ...flatBaseline('RSF-A'),
      { num: 'RSF-A-USD', currency: 'USD', fx: '1.35', total: '1500', date: '2026-07-10', ref: 'RSF-A-U1' },
    ])
    await seedVendorBills(org.orgId, org.subsidiaryId, 'RSF Mixed Vendor', [
      ...flatBaseline('RSF-B'),
      { num: 'RSF-B-CAD', currency: 'CAD', fx: '1', total: '1500', date: '2026-07-13', ref: 'RSF-B-C1' },
    ])
    const data = await runSentinel(org.orgId)
    // Exactly one RSF finding: the genuine same-currency outlier.
    assert.equal(data.rsf.total, 1)
    assert.equal(data.rsf.items[0]!.docNumber, 'RSF-A-USD')
    assert.equal((data.rsf.items[0] as unknown as { currency?: string }).currency, 'USD')
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

/**
 * Z-scores run per document currency: the USD 150 bill is a 3.3σ outlier
 * against its own flat USD baseline (twelve 100s — an in-sample z needs a
 * baseline this deep to clear 3σ), but a single CAD 1500 bill used to inflate
 * the shared baseline deviation and mask it entirely.
 */
test('sentinel z-scores run per currency so foreign bills cannot mask outliers', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  try {
    const baseline = Array.from({ length: 12 }, (_, i) => ({
      num: `Z-BASE-${i}`, currency: 'USD', fx: '1.35', total: '100', date: '2026-06-15', ref: `ZBASE-${i}`,
    }))
    await seedVendorBills(org.orgId, org.subsidiaryId, 'Z Vendor', [
      ...baseline,
      { num: 'Z-USD', currency: 'USD', fx: '1.35', total: '150', date: '2026-07-10', ref: 'Z-U1' },
      { num: 'Z-CAD', currency: 'CAD', fx: '1', total: '1500', date: '2026-07-13', ref: 'Z-C1' },
    ])
    const data = await runSentinel(org.orgId)
    const hits = data.zscore.items.filter((i) => i.amount === 150)
    assert.equal(hits.length, 1)
    assert.equal(hits[0]!.docNumber, 'Z-USD')
    assert.equal((hits[0] as unknown as { currency?: string }).currency, 'USD')
    // The lone CAD bill has no CAD baseline: no z finding, no RSF finding.
    assert.equal(data.zscore.items.filter((i) => i.amount === 1500).length, 0)
    assert.equal(data.rsf.items.filter((i) => i.amount === 1500).length, 0)
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

/**
 * Benford digit analysis partitions by document currency — three USD bills
 * and two CAD bills yield one slice per currency, never a blended signal.
 */
test('sentinel benford runs one distribution per document currency', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  try {
    await seedVendorBills(org.orgId, org.subsidiaryId, 'Benford Vendor', [
      { num: 'B1', currency: 'USD', fx: '1.35', total: '120', date: '2026-07-06', ref: 'B-1' },
      { num: 'B2', currency: 'USD', fx: '1.35', total: '250', date: '2026-07-07', ref: 'B-2' },
      { num: 'B3', currency: 'USD', fx: '1.35', total: '1800', date: '2026-07-08', ref: 'B-3' },
      { num: 'B4', currency: 'CAD', fx: '1', total: '95', date: '2026-07-09', ref: 'B-4' },
      { num: 'B5', currency: 'CAD', fx: '1', total: '410', date: '2026-07-13', ref: 'B-5' },
    ])
    const data = await runSentinel(org.orgId)
    const slices = (data.benford1D as unknown as {
      byCurrency?: Array<{ currency: string; totalTransactions: number }>
    }).byCurrency
    assert.ok(slices)
    assert.equal(slices!.length, 2)
    assert.equal(slices!.find((s) => s.currency === 'USD')?.totalTransactions, 3)
    assert.equal(slices!.find((s) => s.currency === 'CAD')?.totalTransactions, 2)
    // The legacy top-level shape carries the largest slice, not a blend.
    assert.equal(data.benford1D.totalTransactions, 3)
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

/**
 * Sequential runs are per (vendor, currency): the USD run flags with its
 * currency attached; two CAD invoices never reach the run minimum.
 */
test('sentinel sequential runs carry their document currency', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  try {
    await seedVendorBills(org.orgId, org.subsidiaryId, 'Sequence Vendor', [
      { num: 'S1', currency: 'USD', fx: '1.35', total: '500', date: '2026-07-01', ref: 'INV-1001' },
      { num: 'S2', currency: 'USD', fx: '1.35', total: '600', date: '2026-07-06', ref: 'INV-1002' },
      { num: 'S3', currency: 'USD', fx: '1.35', total: '700', date: '2026-07-10', ref: 'INV-1003' },
      { num: 'S4', currency: 'CAD', fx: '1', total: '550', date: '2026-07-02', ref: 'C-2001' },
      { num: 'S5', currency: 'CAD', fx: '1', total: '650', date: '2026-07-09', ref: 'C-2002' },
    ])
    const data = await runSentinel(org.orgId)
    assert.equal(data.sequential.length, 1)
    assert.equal((data.sequential[0] as unknown as { currency?: string }).currency, 'USD')
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

/**
 * Threshold traps stay transaction-denominated: a USD 99.00 bill flags as a
 * 99-trap at 99 (not at its 133.65 functional value), while the consolidated
 * trap total translates at document FX.
 */
test('sentinel traps stay transaction-denominated with translated totals', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  try {
    await seedVendorBills(org.orgId, org.subsidiaryId, 'Trap Vendor', [
      { num: 'TRAP-1', currency: 'USD', fx: '1.35', total: '99', date: '2026-07-14', ref: 'T-1' },
    ])
    const data = await runSentinel(org.orgId)
    assert.equal(data.thresholdTrap.total, 1)
    assert.equal(data.thresholdTrap.items[0]!.amount, 99)
    assert.equal((data.thresholdTrap.items[0] as unknown as { currency?: string }).currency, 'USD')
    assert.equal(data.thresholdTrap.totalAmount, 133.65)
    assert.equal(data.meta.totalAmount, 133.65)
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

/**
 * Consolidated money columns translate at document FX: USD 100 @1.35 plus
 * CAD 100 reads 235 across meta, calendar, vendor risk and the weekend
 * aggregate — and the cross-currency pair is not a duplicate.
 */
test('sentinel consolidated money translates at document FX', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  try {
    await seedVendorBills(org.orgId, org.subsidiaryId, 'Mixed Vendor', [
      { num: 'M-USD', currency: 'USD', fx: '1.35', total: '100', date: '2026-07-11', ref: 'M-U' },
      { num: 'M-CAD', currency: 'CAD', fx: '1', total: '100', date: '2026-07-13', ref: 'M-C' },
    ])
    const data = await runSentinel(org.orgId)
    assert.equal(data.meta.totalAmount, 235)
    assert.equal(data.duplicates.total, 0)
    // 2026-07-11 is a Saturday: the weekend aggregate carries the USD bill
    // translated, not the nominal 100.
    assert.equal(data.weekend.total, 1)
    assert.equal(data.weekend.totalAmount, 135)
    assert.equal(data.summary.totalAtRisk, 135)
    const sat = data.calendar.find((c) => c.date === '2026-07-11')
    const mon = data.calendar.find((c) => c.date === '2026-07-13')
    assert.equal(sat?.amount, 135)
    assert.equal(mon?.amount, 100)
    // Vendor risk rolls flagged (weekend) money up translated.
    assert.equal(data.vendorRisk.length, 1)
    assert.equal(data.vendorRisk[0]!.totalAmount, 135)
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

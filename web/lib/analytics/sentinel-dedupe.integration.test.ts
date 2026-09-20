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
type SentinelGroups = Array<{
  groupId: string; partyName: string; kind: string; currency: string; amount: number
  funcTotal: number; count: number; dateSpanDays: number; sameReference: boolean
  members: Array<{ docId: string; docNumber: string; reference: string; date: string; amount: number }>
}>

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

async function runSentinel(orgId: string) {
  const authz = {
    user: { orgId, id: randomUUID() },
    permissions: new Set(['*']),
    allowedSubsidiaryIds: null,
  } as unknown as Authz
  return withOrgContext(orgId, () => sentinelData(orgId, P, authz))
}

function groupsOf(data: Awaited<ReturnType<typeof sentinelData>>): SentinelGroups {
  return (data.duplicates as unknown as { groups?: SentinelGroups }).groups ?? []
}

/**
 * Hostile scenario from the sentinel currency-mix finding: one vendor, a USD
 * 100 bill and a CAD 100 bill on the same day with the same reference. Same
 * nominal amount, different money — never a duplicate.
 */
test('sentinel duplicates ignore same-amount bills in different currencies', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  try {
    await seedVendorBills(org.orgId, org.subsidiaryId, 'Cross Currency Co', [
      { num: 'BILL-USD', currency: 'USD', fx: '1.35', total: '100', date: '2026-07-10', ref: 'INV-1' },
      { num: 'BILL-CAD', currency: 'CAD', fx: '1', total: '100', date: '2026-07-10', ref: 'INV-1' },
    ])
    const data = await runSentinel(org.orgId)
    assert.equal(data.duplicates.total, 0)
    assert.equal(groupsOf(data).length, 0)
    assert.equal(data.flagged.filter((f) => f.flagType === 'duplicate').length, 0)
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

/**
 * Same vendor, same amount, days apart, but distinct vendor references: a
 * recurring invoice, not a double payment. The reference is part of the key.
 */
test('sentinel duplicates require the same vendor reference', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  try {
    await seedVendorBills(org.orgId, org.subsidiaryId, 'Retainer Co', [
      { num: 'BILL-JUN', currency: 'USD', fx: '1.35', total: '200', date: '2026-07-10', ref: 'INV-101' },
      { num: 'BILL-JUL', currency: 'USD', fx: '1.35', total: '200', date: '2026-07-13', ref: 'INV-102' },
    ])
    const data = await runSentinel(org.orgId)
    assert.equal(data.duplicates.total, 0)
    assert.equal(groupsOf(data).length, 0)
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

/**
 * Three copies of the same natural key (one outside the period boundary)
 * report ONE finding with all three members — not three pair findings — and
 * the value at risk translates every copy beyond the first at document FX.
 */
test('sentinel duplicates report one finding per natural-key group', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  try {
    await seedVendorBills(org.orgId, org.subsidiaryId, 'Triple Bill Co', [
      { num: 'BILL-A', currency: 'USD', fx: '1.35', total: '300', date: '2026-06-29', ref: 'INV-9' },
      { num: 'BILL-B', currency: 'USD', fx: '1.35', total: '300', date: '2026-07-02', ref: 'INV-9' },
      { num: 'BILL-C', currency: 'USD', fx: '1.35', total: '300', date: '2026-07-06', ref: 'INV-9' },
    ])
    const data = await runSentinel(org.orgId)
    assert.equal(data.duplicates.total, 1)
    const groups = groupsOf(data)
    assert.equal(groups.length, 1)
    assert.equal(groups[0]!.count, 3)
    assert.equal(groups[0]!.members.length, 3)
    assert.equal(groups[0]!.currency, 'USD')
    assert.equal(groups[0]!.amount, 300)
    assert.equal(groups[0]!.sameReference, true)
    // Boundary member rides along: the June copy is listed as evidence.
    assert.ok(groups[0]!.members.some((m) => m.docNumber === 'BILL-A'))
    // Value at risk: two excess copies translated at document FX.
    assert.equal(data.summary.totalDuplicateAmount, 810)
    assert.equal(data.flagged.filter((f) => f.flagType === 'duplicate').length, 1)
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

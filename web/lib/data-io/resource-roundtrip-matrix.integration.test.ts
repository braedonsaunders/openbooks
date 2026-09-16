/**
 * DataResource round-trip matrix (static half).
 *
 * For EVERY registered resource: the exporter must never emit a column the
 * importer cannot consume, and the mapping wizard's auto-mapping must map an
 * export header set 100%. Both are checked against a feature-rich org so
 * gated families (subsidiaries, property, payroll, expenses) are included.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    return nextResolve(specifier, context)
  },
})

const { listResources, getResource } = (await import('./resources.ts')) as typeof import(
  './resources.ts'
)
const { guessMapping } = (await import('./parse.ts')) as typeof import('./parse.ts')
hooks.deregister()

const { db } = await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, dropScratchOrgReporting } = await import(
  '@openbooks/engine/src/test-fixtures.ts'
)

const DB = Boolean(process.env.OPENBOOKS_DB_URL)

async function matrixOrg(): Promise<string> {
  const o = await createScratchOrg()
  await db.execute(sql`
    update orgs set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('features', jsonb_build_object(
      'payroll', true, 'propertyManagement', true, 'expenses', true,
      'multiCurrency', true, 'inventory', true, 'equipment', true,
      'fixedAssets', true, 'projects', true, 'projectBilling', true,
      'revenueRecognition', true, 'timeTracking', true, 'multiSubsidiary', true
    )) where id = ${o.orgId}`)
  return o.orgId
}

async function auditOrg(orgId: string, label: string): Promise<string[]> {
  const list = await listResources(orgId)
  console.log(`MATRIX ${label} resources: ${list.length}`)
  const bad: string[] = []
  for (const d of list) {
    const resource = await getResource(orgId, d.key)
    if (!resource) {
      bad.push(`${d.key}: listed but unresolvable`)
      continue
    }
    const fields = await resource.fields()
    const fieldKeys = fields.map((f) => f.key)
    const norm = new Set(fieldKeys.map((k) => k.toLowerCase().replace(/[^a-z0-9]/g, '')))
    const read = await resource.read()
    const exportKeys = read.columns.map((c) => String(c.key))
    const unconsumable = exportKeys.filter(
      (k) => !norm.has(k.toLowerCase().replace(/[^a-z0-9]/g, '')),
    )
    const mapping = guessMapping(exportKeys, fieldKeys)
    const unmapped = exportKeys.filter((k) => !mapping[k])
    if (unconsumable.length > 0 || unmapped.length > 0) {
      bad.push(
        `${d.key}: unconsumable=[${unconsumable.join(',')}] unmapped=[${unmapped.join(',')}]`,
      )
    }
  }
  console.log(`MATRIX ${label} bad: ${bad.length ? bad.join(' | ') : '(none)'}`)
  return bad
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    if (/^(id|.*_at|created_?by|updated_?by)$/i.test(k)) continue
    out[k] = v === null || v === undefined ? null : v
  }
  return out
}

async function writeAll(
  orgId: string,
  actorId: string,
  key: string,
  rows: Record<string, unknown>[],
  mode: 'insert' | 'upsert',
  dryRun: boolean,
): Promise<{ created: number; updated: number; failed: number; errors: { message: string }[]; warnings?: unknown }> {
  const resource = await getResource(orgId, key)
  assert.ok(resource, `${key} resolves`)
  return resource!.write(rows, mode, { orgId, actorId, dryRun })
}

test(
  'seeded history round-trips into a fresh org and re-imports idempotently',
  { skip: !DB, timeout: 300_000 },
  async () => {
    const orgA = await matrixOrg()
    try {
      const actorId = randomUUID()
      // Seed org A through the product writers.
      const setupWest = await writeAll(orgA, actorId, 'subsidiaries', [
        { name: 'West Co', parentId: 'Main Co', baseCurrency: 'CAD', country: 'CA' },
      ], 'insert', false)
      assert.deepEqual(
        { created: setupWest.created, failed: setupWest.failed, errors: setupWest.errors },
        { created: 1, failed: 0, errors: [] },
      )
      const dept = await writeAll(orgA, actorId, 'departments', [
        { code: 'D1', name: 'Dept One', subsidiaryId: 'West Co' },
      ], 'insert', false)
      assert.deepEqual(
        { created: dept.created, failed: dept.failed, errors: dept.errors },
        { created: 1, failed: 0, errors: [] },
      )
      const acct = await writeAll(orgA, actorId, 'accounts', [
        { number: '1190', name: 'Payroll Clearing', type: 'asset_bank' },
      ], 'insert', false)
      assert.deepEqual(
        { created: acct.created, failed: acct.failed, errors: acct.errors },
        { created: 1, failed: 0, errors: [] },
      )
      const item = await writeAll(orgA, actorId, 'items', [
        { code: 'WIDGET', name: 'Widget', kind: 'non_inventory' },
      ], 'insert', false)
      assert.deepEqual(
        { created: item.created, failed: item.failed, errors: item.errors },
        { created: 1, failed: 0, errors: [] },
      )
      const party = await writeAll(orgA, actorId, 'parties', [
        { shortCode: 'ACME', displayName: 'Acme Co', kind: 'company' },
      ], 'insert', false)
      assert.deepEqual(
        { created: party.created, failed: party.failed, errors: party.errors },
        { created: 1, failed: 0, errors: [] },
      )
      // Pocket rows proving UUID-reference round-trips carry natural keys:
      // every ref below is stored as a UUID but must export as a code/name.
      const loc = await writeAll(orgA, actorId, 'locations', [
        { code: 'WH-1', name: 'Warehouse One' },
      ], 'insert', false)
      assert.deepEqual(
        { created: loc.created, failed: loc.failed, errors: loc.errors },
        { created: 1, failed: 0, errors: [] },
      )
      const assy = await writeAll(orgA, actorId, 'items', [
        { code: 'ASSY-1', name: 'Assembly One', kind: 'assembly' },
        { code: 'COMP-1', name: 'Component One', kind: 'non_inventory' },
      ], 'insert', false)
      assert.deepEqual(
        { created: assy.created, failed: assy.failed, errors: assy.errors },
        { created: 2, failed: 0, errors: [] },
      )
      const stock = await writeAll(orgA, actorId, 'stock-locations', [
        { locationId: 'WH-1', code: 'STAGE-1', kind: 'staging' },
      ], 'insert', false)
      assert.deepEqual(
        { created: stock.created, failed: stock.failed, errors: stock.errors },
        { created: 1, failed: 0, errors: [] },
      )
      const assetNo = (
        await db.execute<{ number: string }>(sql`
          select number from accounts where org_id = ${orgA} and number like '1%' order by number limit 1`)
      ).rows[0]?.number
      const cogsNo = (
        await db.execute<{ number: string }>(sql`
          select number from accounts where org_id = ${orgA} and number like '5%' order by number limit 1`)
      ).rows[0]?.number
      assert.ok(assetNo, 'bootstrap CoA carries a 1xxx account')
      assert.ok(cogsNo, 'bootstrap CoA carries a 5xxx account')
      const prof = await writeAll(orgA, actorId, 'item-inventory-profiles', [
        { itemId: 'WIDGET', assetAccountId: assetNo, cogsAccountId: cogsNo },
      ], 'insert', false)
      assert.deepEqual(
        { created: prof.created, failed: prof.failed, errors: prof.errors },
        { created: 1, failed: 0, errors: [] },
      )
      const bom = await writeAll(orgA, actorId, 'bom-components', [
        { assemblyItemId: 'ASSY-1', componentItemId: 'COMP-1', quantityPer: '1' },
      ], 'insert', false)
      assert.deepEqual(
        { created: bom.created, failed: bom.failed, errors: bom.errors },
        { created: 1, failed: 0, errors: [] },
      )
      // Mid-life fixed-asset onboarding: a whole register row carried in from
      // the outgoing system, opening accumulated figures included.
      const faAcct = await writeAll(orgA, actorId, 'accounts', [
        { number: '1500', name: 'Equipment at Cost', type: 'asset_fixed' },
        { number: '1510', name: 'Accumulated Depreciation', type: 'asset_fixed' },
        { number: '6200', name: 'Depreciation Expense', type: 'expense' },
      ], 'insert', false)
      assert.deepEqual(
        { created: faAcct.created, failed: faAcct.failed, errors: faAcct.errors },
        { created: 3, failed: 0, errors: [] },
      )
      const faCat = await writeAll(orgA, actorId, 'asset-categories', [
        {
          name: 'Matrix Equipment',
          assetAccountId: '1500',
          accumulatedDepreciationAccountId: '1510',
          depreciationExpenseAccountId: '6200',
          defaultMethod: 'straight_line',
          defaultLifeMonths: 120,
        },
      ], 'insert', false)
      assert.deepEqual(
        { created: faCat.created, failed: faCat.failed, errors: faCat.errors },
        { created: 1, failed: 0, errors: [] },
      )
      const fa = await writeAll(orgA, actorId, 'fixed-assets', [
        {
          assetNumber: 'FA-1001',
          name: 'Matrix Press',
          category: 'Matrix Equipment',
          subsidiary: 'Main Co',
          acquisitionCost: '120000',
          salvageValue: '0',
          inServiceOn: '2021-06-15',
          status: 'in_service',
          method: 'straight_line',
          lifeMonths: 120,
          convention: 'full_month',
          assetAccount: '1500',
          accumAccount: '1510',
          expenseAccount: '6200',
          openingAccumulated: '55000',
          openingAsOf: '2025-12-31',
        },
      ], 'insert', false)
      assert.deepEqual(
        { created: fa.created, failed: fa.failed, errors: fa.errors },
        { created: 1, failed: 0, errors: [] },
      )
      const revenueNo = (
        await db.execute<{ number: string }>(sql`
          select number from accounts where org_id = ${orgA} and number like '4%' order by number limit 1`)
      ).rows[0]?.number
      assert.ok(revenueNo)
      const invDate = '2026-07-15'
      const inv = await writeAll(orgA, actorId, 'txn:customer_invoice', [
        {
          documentNumber: 'RT-1',
          documentDate: invDate,
          party: 'ACME',
          subsidiary: 'West Co',
          lines: JSON.stringify([{ account: revenueNo, amount: '100.00' }]),
        },
      ], 'insert', false)
      assert.deepEqual(
        { created: inv.created, failed: inv.failed, errors: inv.errors },
        { created: 1, failed: 0, errors: [] },
      )

      // Fresh org B with identical features, then import in dependency order.
      // Generic loop over every setup + master key: populated resources prove
      // equality + idempotent re-import; empty ones report vacuous.
      const orgB = await matrixOrg()
      try {
        const { listResources: listRes } = await import('./resources.ts')
        const order = (await listRes(orgA)).map((d) => d.key)
        // Migration runbook order: master data first (setup rows such as
        // inventory profiles and BOMs point at items), then setup in registry
        // order, then transactions. listResources groups setup before master,
        // which would strand every cross-group reference.
        const masterFirst = ['accounts', 'items', 'parties', 'customers']
        const setupRest = order.filter((k) => !masterFirst.includes(k))
        const keys = [...order.filter((k) => masterFirst.includes(k)), ...setupRest.filter(
          (k) =>
            k !== 'extension-settings' &&
            !k.startsWith('txn:') &&
            !k.startsWith('record:') &&
            !['payroll-opening-balances', 'payroll-opening-entitlements', 'prior-payroll-register'].includes(k) &&
            !k.startsWith('properties') &&
            k !== 'property-units' &&
            k !== 'property-leases' &&
            k !== 'lease-charges' &&
            k !== 'security-deposit-opening-balances',
        )]
        keys.push('txn:customer_invoice')
        // Insert mode never updates; every row is either created or refused.
        // The second import must create nothing and leave B byte-identical:
        // that is the idempotency contract, independent of row order.
        for (const key of keys) {
          const ra = await getResource(orgA, key)
          const rb = await getResource(orgB, key)
          assert.ok(ra && rb, `${key} resolves in both orgs`)
          const a = await ra!.read()
          const b0 = await rb!.read()
          if (a.rows.length === 0) {
            // Vacuous is still asserted: an empty export must import nothing
            // into an empty resource (both orgs seed the same fixture).
            assert.deepEqual(
              (b0.rows as Record<string, unknown>[]).map(normalizeRow), [],
              `${key}: empty export must meet an empty resource`,
            )
            console.log(`MATRIX DYNAMIC ${key}: VERDICT vacuous-pass (0 rows)`)
            continue
          }
          const rows = a.rows as Record<string, unknown>[]
          const first = await writeAll(orgB, actorId, key, rows, 'insert', false)
          console.log(`MATRIX DYNAMIC ${key}: rows=${rows.length} first=${JSON.stringify({ created: first.created, updated: first.updated, failed: first.failed, errors: first.errors.map((e) => e.message).slice(0, 2) })}`)
          assert.equal(first.updated, 0, `${key}: insert mode must never update`)
          assert.equal(
            first.created + first.failed, rows.length,
            `${key}: every row is created or refused (${first.created}+${first.failed}!=${rows.length})`,
          )
          const b = await rb!.read()
          const norm = (rs: Record<string, unknown>[]) => rs.map(normalizeRow)
            .sort((x, y) => String(JSON.stringify(x)).localeCompare(String(JSON.stringify(y))))
          const normA = norm(rows)
          const normB = norm(b.rows as Record<string, unknown>[])
          if (JSON.stringify(normA) !== JSON.stringify(normB)) {
            console.log(`MATRIX DYNAMIC ${key} A=${JSON.stringify(normA).slice(0, 1500)}`)
            console.log(`MATRIX DYNAMIC ${key} B=${JSON.stringify(normB).slice(0, 1500)}`)
          }
          assert.deepEqual(normB, normA, `${key}: fresh-org import must equal the export`)
          const second = await writeAll(orgB, actorId, key, rows, 'insert', false)
          console.log(`MATRIX DYNAMIC ${key}: second=${JSON.stringify({ created: second.created, updated: second.updated, failed: second.failed, errors: second.errors.map((e) => e.message).slice(0, 2) })}`)
          assert.equal(second.created, 0, `${key}: re-import must create nothing`)
          assert.equal(second.updated, 0, `${key}: re-import must update nothing`)
          const b2 = await rb!.read()
          assert.deepEqual(
            norm(b2.rows as Record<string, unknown>[]), normB,
            `${key}: re-import must leave the org unchanged`,
          )
          console.log(`MATRIX DYNAMIC ${key}: VERDICT pass (rows=${rows.length} created=${first.created} refused=${first.failed})`)
        }
      } finally {
        await dropScratchOrgReporting(orgB)
      }
    } finally {
      await dropScratchOrgReporting(orgA)
    }
  },
)

test(
  'every registered resource exports only consumable, auto-mapped columns',
  { skip: !DB, timeout: 300_000 },
  async () => {
    // Feature-rich AND feature-poor: column gating must match field gating
    // under both, or an export emits columns its own importer hides.
    const rich = await matrixOrg()
    try {
      const poor = await createScratchOrg()
      try {
        const badRich = await auditOrg(rich, 'rich')
        const badPoor = await auditOrg(poor.orgId, 'poor')
        assert.deepEqual([...badRich, ...badPoor], [])
      } finally {
        await dropScratchOrgReporting(poor.orgId)
      }
    } finally {
      await dropScratchOrgReporting(rich)
    }
  },
)

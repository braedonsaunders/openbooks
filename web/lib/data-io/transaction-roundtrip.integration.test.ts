import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

// Data-io resources are server-only. Shim that marker so this focused
// PostgreSQL boundary test can import them under node's test runner.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    return nextResolve(specifier, context)
  },
})

const { DOC_KINDS } = (await import('../document-kinds.ts')) as typeof import('../document-kinds.ts')
const { transactionResource } = (await import('./transaction-resources.ts')) as typeof import(
  './transaction-resources.ts'
)
hooks.deregister()

const { db } = await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, dropScratchOrgReporting } = await import(
  '@openbooks/engine/src/test-fixtures.ts'
)

const DB = Boolean(process.env.OPENBOOKS_DB_URL)

interface Fixture {
  orgId: string
  date: string
  revenueNo: string
  customerId: string
}

/**
 * Lease a fresh scratch org per top-level test. The suite's fixture lifecycle
 * hook drains forgotten leases at every top-level test boundary, so an org
 * memoized across tests is reset — and re-leased to another worker process —
 * as soon as the first test ends.
 */
async function fixture(): Promise<Fixture> {
  const o = await createScratchOrg()
  const revenueNo = (
    await db.execute<{ number: string }>(
      sql`select number from accounts where id = ${o.accounts.revenue}`,
    )
  ).rows[0]?.number
  assert.ok(revenueNo)
  return { orgId: o.orgId, date: o.date, revenueNo, customerId: o.customerId }
}

async function writeInvoice(fx: Fixture, row: Record<string, unknown>) {
  const cfg = DOC_KINDS.customer_invoice
  assert.ok(cfg)
  return transactionResource(cfg, fx.orgId).write([row], 'insert', {
    orgId: fx.orgId,
    actorId: randomUUID(),
    dryRun: false,
  })
}

async function exportedInvoice(fx: Fixture): Promise<Record<string, unknown>> {
  const cfg = DOC_KINDS.customer_invoice
  assert.ok(cfg)
  const exported = await transactionResource(cfg, fx.orgId).read()
  assert.equal(exported.rows.length, 1)
  return { ...(exported.rows[0] as Record<string, unknown>) }
}

/**
 * An exported row must re-import: the exporter emits the same keys the
 * importer resolves, so a file the system wrote itself is always readable.
 * The document number is dropped to mint a fresh document (re-importing the
 * same number stays a duplicate failure by design — posted history is never
 * rewritten).
 */
test(
  'an exported invoice re-imports when multi-currency is off',
  { skip: !DB, timeout: 180_000 },
  async () => {
    const fx = await fixture()
    try {
      // A resolvable party, so the only friction left is the exporter's own
      // always-emitted currency column on a single-currency org.
      await db.execute(sql`update parties set short_code = 'ACME' where id = ${fx.customerId}`)
      const created = await writeInvoice(fx, {
        documentDate: fx.date,
        party: 'ACME',
        lines: JSON.stringify([{ account: fx.revenueNo, amount: '42.50' }]),
      })
      assert.deepEqual(
        { created: created.created, failed: created.failed },
        { created: 1, failed: 0 },
      )

      const row = await exportedInvoice(fx)
      assert.equal(row.currency, 'CAD')
      delete row.documentNumber
      const replay = await writeInvoice(fx, row)
      assert.deepEqual(
        { created: replay.created, failed: replay.failed, errors: replay.errors },
        { created: 1, failed: 0, errors: [] },
      )
    } finally {
      await dropScratchOrgReporting(fx.orgId)
    }
  },
)

test(
  'a foreign currency still needs the multi-currency feature',
  { skip: !DB, timeout: 180_000 },
  async () => {
    const fx = await fixture()
    try {
      // The base-currency pass-through above must not open the gate: a
      // genuinely foreign currency on a single-currency org keeps failing.
      // (The currency check runs before party resolution, so no party setup
      // is needed for this row to reach the gate.)
      const outcome = await writeInvoice(fx, {
        documentDate: fx.date,
        party: 'Nobody Will Resolve',
        currency: 'USD',
        lines: JSON.stringify([{ account: fx.revenueNo, amount: '42.50' }]),
      })
      assert.deepEqual(
        { created: outcome.created, failed: outcome.failed },
        { created: 0, failed: 1 },
      )
      assert.match(outcome.errors[0]?.message ?? '', /currency is not available/)
    } finally {
      await dropScratchOrgReporting(fx.orgId)
    }
  },
)

test(
  'an exported invoice re-imports when the party has no short code',
  { skip: !DB, timeout: 180_000 },
  async () => {
    const fx = await fixture()
    try {
      // The scratch customer carries a NULL short code — legal — and the
      // importer resolves parties by short code with a display-name fallback.
      // The exporter must emit that same key, not a null the importer rejects.
      const created = await writeInvoice(fx, {
        documentDate: fx.date,
        party: 'Acme Customer',
        lines: JSON.stringify([{ account: fx.revenueNo, amount: '42.50' }]),
      })
      assert.deepEqual(
        { created: created.created, failed: created.failed },
        { created: 1, failed: 0 },
      )

      const row = await exportedInvoice(fx)
      delete row.documentNumber
      delete row.currency
      const replay = await writeInvoice(fx, row)
      assert.deepEqual(
        { created: replay.created, failed: replay.failed, errors: replay.errors },
        { created: 1, failed: 0, errors: [] },
      )
    } finally {
      await dropScratchOrgReporting(fx.orgId)
    }
  },
)

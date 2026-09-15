/**
 * Cutover subsidiary fidelity for the transaction import surface.
 *
 * A tenant cutting over with more than one legal entity must be able to
 * attribute opening documents per subsidiary — and a document's subsidiary
 * must agree with the GL it posts. Today the transaction importer accepts no
 * subsidiary at all: the file comment claims "transaction rows carry their
 * subsidiary on the document header", but no import column feeds it and the
 * insert leaves subsidiary_id NULL. The kernel then posts every leg to the
 * org root while the document row says NULL, so:
 *
 * - subsidiary trial balances misattribute the whole cutover to the root;
 * - subsidiary-fenced lists, exports, backups, and tools (all
 *   `subsidiary_id = any(...)`) cannot see the imported documents at all,
 *   while org totals include them — the first close cannot be reconciled.
 *
 * These cases pin the contract: an explicit subsidiary by name attributes
 * the document (and survives an export round-trip); an omitted subsidiary is
 * stamped with the org root (exactly the subsidiary the kernel posts to, so
 * document and GL agree); an unknown subsidiary fails the row closed.
 */
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
  rootId: string
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
  await db.execute(sql`update parties set short_code = 'ACME' where id = ${o.customerId}`)
  return { orgId: o.orgId, date: o.date, revenueNo, customerId: o.customerId, rootId: o.subsidiaryId }
}

async function addSubsidiary(fx: Fixture, name: string): Promise<string> {
  const [row] = (
    await db.execute<{ id: string }>(sql`
      insert into subsidiaries (org_id, parent_id, name, base_currency, country)
      values (${fx.orgId}, ${fx.rootId}, ${name}, 'CAD', 'CA')
      returning id`)
  ).rows
  assert.ok(row?.id)
  return row.id
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

async function storedSubsidiaryId(fx: Fixture, documentNumber: string): Promise<string | null> {
  const [row] = (
    await db.execute<{ subsidiary_id: string | null }>(sql`
      select subsidiary_id from documents
       where org_id = ${fx.orgId} and document_number = ${documentNumber}`)
  ).rows
  return row?.subsidiary_id ?? null
}

test(
  'an imported invoice attributes its subsidiary by name',
  { skip: !DB, timeout: 180_000 },
  async () => {
    const fx = await fixture()
    try {
      const westId = await addSubsidiary(fx, 'West Co')
      const outcome = await writeInvoice(fx, {
        documentNumber: 'SUB-1',
        documentDate: fx.date,
        party: 'ACME',
        subsidiary: 'West Co',
        lines: JSON.stringify([{ account: fx.revenueNo, amount: '100.00' }]),
      })
      assert.deepEqual(
        { created: outcome.created, failed: outcome.failed, errors: outcome.errors },
        { created: 1, failed: 0, errors: [] },
      )
      assert.equal(
        await storedSubsidiaryId(fx, 'SUB-1'),
        westId,
        'the document carries the named subsidiary, not NULL and not the root',
      )
    } finally {
      await dropScratchOrgReporting(fx.orgId)
    }
  },
)

test(
  'an omitted subsidiary is stamped with the root the kernel posts to',
  { skip: !DB, timeout: 180_000 },
  async () => {
    const fx = await fixture()
    try {
      const outcome = await writeInvoice(fx, {
        documentNumber: 'SUB-2',
        documentDate: fx.date,
        party: 'ACME',
        lines: JSON.stringify([{ account: fx.revenueNo, amount: '50.00' }]),
      })
      assert.deepEqual(
        { created: outcome.created, failed: outcome.failed },
        { created: 1, failed: 0 },
      )
      assert.equal(
        await storedSubsidiaryId(fx, 'SUB-2'),
        fx.rootId,
        'no silent NULL: the document agrees with the root-subsidiary GL legs',
      )
    } finally {
      await dropScratchOrgReporting(fx.orgId)
    }
  },
)

test(
  'an unknown subsidiary fails the row closed',
  { skip: !DB, timeout: 180_000 },
  async () => {
    const fx = await fixture()
    try {
      const outcome = await writeInvoice(fx, {
        documentNumber: 'SUB-3',
        documentDate: fx.date,
        party: 'ACME',
        subsidiary: 'No Such Entity',
        lines: JSON.stringify([{ account: fx.revenueNo, amount: '50.00' }]),
      })
      assert.deepEqual(
        { created: outcome.created, failed: outcome.failed },
        { created: 0, failed: 1 },
      )
      assert.match(outcome.errors[0]?.message ?? '', /No Such Entity/)
      assert.equal(await storedSubsidiaryId(fx, 'SUB-3'), null)
    } finally {
      await dropScratchOrgReporting(fx.orgId)
    }
  },
)

test(
  'an exported subsidiary round-trips back onto the same subsidiary',
  { skip: !DB, timeout: 180_000 },
  async () => {
    const fx = await fixture()
    try {
      const westId = await addSubsidiary(fx, 'West Co')
      const created = await writeInvoice(fx, {
        documentNumber: 'SUB-4',
        documentDate: fx.date,
        party: 'ACME',
        subsidiary: 'West Co',
        lines: JSON.stringify([{ account: fx.revenueNo, amount: '75.00' }]),
      })
      assert.equal(created.failed, 0)
      const cfg = DOC_KINDS.customer_invoice
      assert.ok(cfg)
      const exported = await transactionResource(cfg, fx.orgId).read()
      const row = (exported.rows as Record<string, unknown>[]).find(
        (r) => r.documentNumber === 'SUB-4',
      )
      assert.equal(
        row?.subsidiary,
        'West Co',
        'the exporter emits the key the importer resolves',
      )
      delete row?.documentNumber
      const replay = await writeInvoice(fx, { ...(row as Record<string, unknown>) })
      assert.deepEqual(
        { created: replay.created, failed: replay.failed, errors: replay.errors },
        { created: 1, failed: 0, errors: [] },
      )
      const [copy] = (
        await db.execute<{ subsidiary_id: string | null }>(sql`
          select subsidiary_id from documents
           where org_id = ${fx.orgId} and document_number <> 'SUB-4'
             and kind = 'customer_invoice'`)
      ).rows
      assert.equal(copy?.subsidiary_id, westId)
    } finally {
      await dropScratchOrgReporting(fx.orgId)
    }
  },
)

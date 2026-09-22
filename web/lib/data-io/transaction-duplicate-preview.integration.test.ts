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

const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrgReporting } = await import(
  '@openbooks/engine/src/testing/fixtures.ts'
)

const DB = Boolean(process.env.OPENBOOKS_DB_URL)

interface Fixture {
  orgId: string
  date: string
  expenseNo: string
}

/**
 * Lease a fresh scratch org per top-level test. The suite's fixture lifecycle
 * hook drains forgotten leases at every top-level test boundary, so an org
 * memoized across tests is reset — and re-leased to another worker process —
 * as soon as the first test ends.
 */
async function fixture(): Promise<Fixture> {
  const o = await withBypassContext(() => createScratchOrg())
  await withBypassContext(() =>
    db.execute(sql`update parties set short_code = 'ACMEV' where id = ${o.vendorId}`),
  )
  const expenseNo = (
    await withOrgContext(o.orgId, () =>
      db.execute<{ number: string }>(sql`select number from accounts where id = ${o.accounts.cogs}`),
    )
  ).rows[0]?.number
  assert.ok(expenseNo)
  return { orgId: o.orgId, date: o.date, expenseNo }
}

function billRow(fx: Fixture, documentNumber?: string): Record<string, unknown> {
  return {
    ...(documentNumber !== undefined ? { documentNumber } : {}),
    documentDate: fx.date,
    party: 'ACMEV',
    account: fx.expenseNo,
    amount: '100.00',
  }
}

async function writeBills(
  fx: Fixture,
  kind: string,
  rows: Record<string, unknown>[],
  dryRun: boolean,
) {
  const cfg = (DOC_KINDS as Record<string, (typeof DOC_KINDS)['vendor_bill']>)[kind]
  assert.ok(cfg, `unknown doc kind ${kind}`)
  return withOrgContext(fx.orgId, () =>
    transactionResource(cfg, fx.orgId).write(rows, 'insert', {
      orgId: fx.orgId,
      actorId: randomUUID(),
      dryRun,
    }),
  )
}

async function countDocs(fx: Fixture, kind: string, documentNumber: string): Promise<number> {
  const n = await withOrgContext(fx.orgId, () =>
    db.execute<{ n: number }>(sql`
      select count(*)::int as n from documents
       where org_id = ${fx.orgId} and kind = ${kind} and document_number = ${documentNumber}`),
  )
  return n.rows[0]?.n ?? 0
}

/**
 * Two identical vendor_bill numbers in one file: the preview must anticipate
 * the commit. Both runs classify the second row as a duplicate failure while
 * the first succeeds (partial success is preserved — the valid row commits).
 */
test(
  'duplicate document numbers fail the preview exactly as they fail the commit',
  { skip: !DB, timeout: 180_000 },
  async () => {
    const fx = await fixture()
    try {
      const rows = [billRow(fx, 'DUP-1'), billRow(fx, 'DUP-1')]
      const preview = await writeBills(fx, 'vendor_bill', rows, true)
      assert.deepEqual(
        { created: preview.created, failed: preview.failed },
        { created: 1, failed: 1 },
      )
      assert.match(preview.errors[0]?.message ?? '', /DUP-1.*already exists/)
      assert.equal(preview.errors[0]?.row, 2)

      const commit = await writeBills(fx, 'vendor_bill', rows, false)
      assert.deepEqual(
        { created: commit.created, failed: commit.failed },
        { created: 1, failed: 1 },
      )
      assert.match(commit.errors[0]?.message ?? '', /DUP-1.*already exists/)
      assert.equal(commit.errors[0]?.row, 2)
      assert.equal(await countDocs(fx, 'vendor_bill', 'DUP-1'), 1)
    } finally {
      await dropScratchOrgReporting(fx.orgId)
    }
  },
)

/**
 * A first row that fails validation must not reserve its number: the valid
 * second row with the same number succeeds in both preview and commit.
 */
test(
  'an invalid first row does not reserve its document number',
  { skip: !DB, timeout: 180_000 },
  async () => {
    const fx = await fixture()
    try {
      const bad = { ...billRow(fx, 'DUP-2'), account: '9999' }
      const rows = [bad, billRow(fx, 'DUP-2')]
      const preview = await writeBills(fx, 'vendor_bill', rows, true)
      assert.deepEqual(
        { created: preview.created, failed: preview.failed },
        { created: 1, failed: 1 },
      )
      assert.match(preview.errors[0]?.message ?? '', /account "9999" not found/)
      assert.equal(preview.errors[0]?.row, 1)

      const commit = await writeBills(fx, 'vendor_bill', rows, false)
      assert.deepEqual(
        { created: commit.created, failed: commit.failed },
        { created: 1, failed: 1 },
      )
      assert.equal(await countDocs(fx, 'vendor_bill', 'DUP-2'), 1)
    } finally {
      await dropScratchOrgReporting(fx.orgId)
    }
  },
)

/**
 * Uniqueness is per (org, kind, document_number) — documents_org_kind_number —
 * so a vendor_bill and a vendor_credit may share one number in the same file.
 */
test(
  'the same number under a different kind is not a duplicate',
  { skip: !DB, timeout: 180_000 },
  async () => {
    const fx = await fixture()
    try {
      const previewBill = await writeBills(fx, 'vendor_bill', [billRow(fx, 'SHARED-1')], true)
      const previewCredit = await writeBills(fx, 'vendor_credit', [billRow(fx, 'SHARED-1')], true)
      assert.deepEqual(
        { created: previewBill.created, failed: previewBill.failed },
        { created: 1, failed: 0 },
      )
      assert.deepEqual(
        { created: previewCredit.created, failed: previewCredit.failed },
        { created: 1, failed: 0 },
      )

      const commitBill = await writeBills(fx, 'vendor_bill', [billRow(fx, 'SHARED-1')], false)
      const commitCredit = await writeBills(fx, 'vendor_credit', [billRow(fx, 'SHARED-1')], false)
      assert.deepEqual(
        { created: commitBill.created, failed: commitBill.failed },
        { created: 1, failed: 0 },
      )
      assert.deepEqual(
        { created: commitCredit.created, failed: commitCredit.failed },
        { created: 1, failed: 0 },
      )
    } finally {
      await dropScratchOrgReporting(fx.orgId)
    }
  },
)

/**
 * Rows without a number mint generated sequence numbers, so two anonymous
 * rows in one file never collide — in preview or at commit.
 */
test(
  'anonymous rows mint distinct generated numbers',
  { skip: !DB, timeout: 180_000 },
  async () => {
    const fx = await fixture()
    try {
      const rows = [billRow(fx), billRow(fx)]
      const preview = await writeBills(fx, 'vendor_bill', rows, true)
      assert.deepEqual(
        { created: preview.created, failed: preview.failed },
        { created: 2, failed: 0 },
      )
      const commit = await writeBills(fx, 'vendor_bill', rows, false)
      assert.deepEqual(
        { created: commit.created, failed: commit.failed },
        { created: 2, failed: 0 },
      )
    } finally {
      await dropScratchOrgReporting(fx.orgId)
    }
  },
)

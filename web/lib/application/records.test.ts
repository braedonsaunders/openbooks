import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

// records.ts composes the engine pool and server-only services; shim the
// marker package so the module graph loads under the plain runner (same seam
// technique as documents.test.ts). The subsidiary/kind fences below bind
// PostgreSQL array literals, and a malformed binding only fails against live
// Postgres once the bound collection holds more than one element — so every
// restricted collection exercised here is deliberately multi-element.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    return nextResolve(specifier, context)
  },
})

const { listRecords, getRecord, normalizeDocumentRecordRevisions } = await import('./records.ts')
const { ApplicationError } = await import('./errors.ts')
const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  '@openbooks/engine/src/test-fixtures.ts'
)

interface SeededDocument {
  id: string
  kind: string
  subsidiaryId: string
}

interface Fixture {
  orgId: string
  actorId: string
  /** [home (seeded by the scratch org), branch (inserted here)]. */
  subsidiaries: [string, string]
  bills: SeededDocument[]
  payments: SeededDocument[]
}

async function insertDocument(
  orgId: string,
  actorId: string,
  date: string,
  kind: string,
  documentNumber: string,
  partyId: string,
  subsidiaryId: string,
): Promise<string> {
  const id = randomUUID()
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, party_id, subsidiary_id,
       document_date, currency, status, subtotal, tax_total, total, memo,
       custom, extra_dims, created_by, created_at, updated_at, updated_by)
    values
      (${id}, ${orgId}, ${kind}, ${documentNumber}, ${partyId}, ${subsidiaryId},
       ${date}, 'CAD', 'draft', '0', '0', '0', 'array binding evidence',
       '{}'::jsonb, '{}'::jsonb, ${actorId}, now(), now(), null)
  `)
  return id
}

async function seed(): Promise<Fixture> {
  const org = await createScratchOrg()
  const actorId = (await seedFlowActors(org.orgId)).adminId

  // The scratch org seeds exactly one root subsidiary ("Main Co"); a child
  // subsidiary makes every fence in this suite provably multi-element.
  const branchSubsidiaryId = randomUUID()
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    values (${branchSubsidiaryId}, ${org.orgId}, ${org.subsidiaryId}, 'Branch Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`)

  const billSubsidiaries = [org.subsidiaryId, org.subsidiaryId, branchSubsidiaryId]
  const bills: SeededDocument[] = []
  for (const [i, subsidiaryId] of billSubsidiaries.entries()) {
    bills.push({
      id: await insertDocument(
        org.orgId, actorId, org.date,
        'vendor_bill', `REC-BILL-${i + 1}`, org.vendorId, subsidiaryId,
      ),
      kind: 'vendor_bill',
      subsidiaryId,
    })
  }

  const payments: SeededDocument[] = [
    {
      id: await insertDocument(
        org.orgId, actorId, org.date,
        'vendor_payment', 'REC-PAY-1', org.vendorId, org.subsidiaryId,
      ),
      kind: 'vendor_payment',
      subsidiaryId: org.subsidiaryId,
    },
    {
      id: await insertDocument(
        org.orgId, actorId, org.date,
        'customer_payment', 'REC-PAY-2', org.customerId, branchSubsidiaryId,
      ),
      kind: 'customer_payment',
      subsidiaryId: branchSubsidiaryId,
    },
  ]

  return {
    orgId: org.orgId,
    actorId,
    subsidiaries: [org.subsidiaryId, branchSubsidiaryId],
    bills,
    payments,
  }
}

function contextFor(fixture: Fixture, allowedSubsidiaryIds: ReadonlySet<string>) {
  const user = {
    id: fixture.actorId,
    email: 'records-fence@scratch.test',
    name: 'Records Fence Controller',
    roles: [{ key: 'admin', name: 'Admin' }],
    orgId: fixture.orgId,
    envKind: 'production' as const,
    productionOrgId: fixture.orgId,
    isSuperAdmin: false,
    homeUserId: fixture.actorId,
    homeOrgId: fixture.orgId,
  }
  return {
    authz: { user, permissions: new Set(['*']), allowedSubsidiaryIds: new Set(allowedSubsidiaryIds) },
    source: 'api' as const,
    requestId: randomUUID(),
    apiKeyId: null,
  }
}

function notFound(error: unknown): boolean {
  return error instanceof ApplicationError && error.code === 'not_found'
}

test(
  'document-backed list/get succeed under a multi-subsidiary scope and multi-kind allowlist',
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const fixture = await withBypass(seed)
    try {
      const bothSubsidiaries = new Set(fixture.subsidiaries)
      await withOrgContext(fixture.orgId, async () => {
        const context = contextFor(fixture, bothSubsidiaries)

        // "payments" resolves the two-element ["vendor_payment",
        // "customer_payment"] kind allowlist while the subsidiary fence binds
        // two uuids — both collections are multi-element on purpose.
        const listed = await listRecords(context, { typeKey: 'payments' })
        assert.equal(listed.total, fixture.payments.length)
        assert.deepEqual(
          listed.records.map((record) => record.id).sort(),
          fixture.payments.map((payment) => payment.id).sort(),
        )
        assert.deepEqual(
          [...new Set(listed.records.map((record) => record.kind))].sort(),
          ['customer_payment', 'vendor_payment'],
        )
        for (const payment of fixture.payments) {
          const record = await getRecord(context, { typeKey: 'payments', id: payment.id })
          assert.equal(record.id, payment.id)
          assert.equal(record.kind, payment.kind)
        }

        // "bills" carries a single-element kind allowlist but still exercises
        // the multi-element subsidiary fence across list and get.
        const bills = await listRecords(context, { typeKey: 'bills' })
        assert.equal(bills.total, fixture.bills.length)
        assert.deepEqual(
          bills.records.map((record) => record.id).sort(),
          fixture.bills.map((bill) => bill.id).sort(),
        )
        const fetched = await getRecord(context, { typeKey: 'bills', id: fixture.bills[2]!.id })
        assert.equal(fetched.id, fixture.bills[2]!.id)
        assert.equal(fetched.subsidiary_id, fixture.subsidiaries[1])
      })
    } finally {
      await withBypass(() => dropScratchOrg(fixture.orgId))
    }
  },
)

test(
  'a narrower subsidiary scope filters rows instead of failing the query',
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const fixture = await withBypass(seed)
    try {
      const homeOnly = new Set([fixture.subsidiaries[0]])
      const branchBill = fixture.bills[2]!
      const branchPayment = fixture.payments[1]!
      await withOrgContext(fixture.orgId, async () => {
        const context = contextFor(fixture, homeOnly)

        const payments = await listRecords(context, { typeKey: 'payments' })
        assert.equal(payments.total, 1)
        assert.equal(payments.records[0]?.id, fixture.payments[0]!.id)
        assert.equal(payments.records[0]?.kind, 'vendor_payment')
        await assert.rejects(
          getRecord(context, { typeKey: 'payments', id: branchPayment.id }),
          notFound,
        )

        const bills = await listRecords(context, { typeKey: 'bills' })
        assert.equal(bills.total, 2)
        assert.deepEqual(
          bills.records.map((record) => record.id).sort(),
          fixture.bills.slice(0, 2).map((bill) => bill.id).sort(),
        )
        await assert.rejects(getRecord(context, { typeKey: 'bills', id: branchBill.id }), notFound)
      })
    } finally {
      await withBypass(() => dropScratchOrg(fixture.orgId))
    }
  },
)

test(
  'an empty subsidiary scope yields zero rows without binding an array at all',
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const fixture = await withBypass(seed)
    try {
      await withOrgContext(fixture.orgId, async () => {
        const context = contextFor(fixture, new Set())
        const payments = await listRecords(context, { typeKey: 'payments' })
        assert.equal(payments.total, 0)
        assert.deepEqual(payments.records, [])
        const bills = await listRecords(context, { typeKey: 'bills' })
        assert.equal(bills.total, 0)
        await assert.rejects(getRecord(context, { typeKey: 'bills', id: fixture.bills[0]!.id }), notFound)
      })
    } finally {
      await withBypass(() => dropScratchOrg(fixture.orgId))
    }
  },
)

test('document-backed record payloads keep their exact persisted revision', () => {
  const lossy = new Date('2026-08-24T12:34:56.123Z')
  const exact = '2026-08-24T12:34:56.123456Z'
  const [record] = normalizeDocumentRecordRevisions('documents', [{
    id: '00000000-0000-4000-8000-000000000001',
    updated_at: lossy,
    __documentRevision: exact,
  }])
  assert.equal(record?.updated_at, exact)
  assert.equal('__documentRevision' in (record ?? {}), false)
})

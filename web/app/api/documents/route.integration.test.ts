import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import type { SessionUser } from '../../../lib/auth'

/**
 * POST /api/documents: uniform unsaved-create Save for the nine shared
 * DOCUMENT kinds.
 *
 * Opening New allocates nothing (client-side, URL-only); this endpoint is
 * the first write. A first create commits claim + number + insert audit +
 * full validated header/lines in ONE transaction and emits exactly two
 * audit events (insert with the request image, update with
 * initialization → final snapshots). An exact retry replays (200, no new
 * rows, no sequence burn); a changed payload or cross-org key 409s. An
 * invalid Save leaves zero document, zero audit, zero sequence movement,
 * and no idempotency claim behind.
 *
 * Only the session gate is doubled. Validation, UUID, decimal,
 * canonical-JSON, numbering, and the JSON boundary all run REAL.
 */
const root = pathToFileURL(process.cwd() + '/').href
const state: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __documentCreateUser: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === 'next-intl/server') {
      return virtual('export async function getTranslations(){return (key)=>key}; export async function getLocale(){return "en"}')
    }
    if ((specifier === './auth' || specifier.endsWith('/lib/auth')) && context.parentURL?.endsWith('/web/lib/authz.ts')) {
      return virtual('export async function currentUser(){return globalThis.__documentCreateUser.user}')
    }
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { POST } = await import('./route')

const post = (body: unknown, key: string) =>
  POST(
    new Request('http://audit.local/api/documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify(body),
    }),
  )

async function setup() {
  const org = await withBypassContext(() => createScratchOrg())
  const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Doc creator', 'doc_creator'))
  await withBypassContext(() =>
    db.execute(sql`update app_roles set permissions='["ar.read","ar.create","ap.read","ap.create","gl.post","gl.read","banking.read"]'::jsonb where org_id=${org.orgId} and key='doc_creator'`),
  )
  // Second bank account (transfer legs) + card-liability account (card control).
  const bank2 = randomUUID()
  const cardLiability = randomUUID()
  await withBypassContext(async () => {
    await db.execute(sql`
      insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
      values (${bank2}, ${org.orgId}, '1001', 'Savings', 'asset_bank', false, true, false, true, '[]'::jsonb, '{}'::jsonb, true)`)
    await db.execute(sql`
      insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
      values (${cardLiability}, ${org.orgId}, '2100', 'Corp Card', 'liability_card', false, true, false, true, '[]'::jsonb, '{}'::jsonb, true)`)
  })
  state.user = {
    id: actor, orgId: org.orgId, name: 'Doc creator', email: 'creator@scratch.test',
    roles: [], isSuperAdmin: false, envKind: 'production',
    productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor,
  }
  return { org, actor, bank2, cardLiability }
}

const docCount = (orgId: string, id: string) =>
  withBypassContext(async () =>
    Number(
      (await db.execute<{ n: string }>(sql`select count(*)::text as n from documents where id = ${id} and org_id = ${orgId}`))
        .rows[0]!.n,
    ),
  )

const auditRows = (orgId: string, id: string) =>
  withBypassContext(async () =>
    (
      await db.execute<{ action: string; requestId: string | null; changes: unknown }>(sql`
        select action, request_id as "requestId", changes from audit_log
         where org_id = ${orgId} and table_name = 'documents' and row_id = ${id}
         order by at asc`)
    ).rows,
  )

const seqNext = (orgId: string, kind: string) =>
  withBypassContext(async () =>
    (
      await db.execute<{ n: number }>(sql`select next_number as n from number_sequences where org_id = ${orgId} and document_kind = ${kind}`)
    ).rows[0]?.n ?? null,
  )

const bodies = (org: Awaited<ReturnType<typeof setup>>['org'], bank2: string, cardLiability: string) => ({
  customer_invoice: {
    kind: 'customer_invoice', partyId: org.customerId, documentDate: org.date,
    lines: [{ accountId: org.accounts.revenue, amount: '100', description: 'Widget' }],
  },
  customer_credit: {
    kind: 'customer_credit', partyId: org.customerId, documentDate: org.date,
    lines: [{ accountId: org.accounts.revenue, amount: '40', description: 'Return' }],
  },
  vendor_bill: {
    kind: 'vendor_bill', partyId: org.vendorId, documentDate: org.date,
    lines: [{ accountId: org.accounts.cogs, amount: '50', description: 'Parts' }],
  },
  vendor_credit: {
    kind: 'vendor_credit', partyId: org.vendorId, documentDate: org.date,
    lines: [{ accountId: org.accounts.cogs, amount: '20', description: 'Rebate' }],
  },
  card_charge: {
    kind: 'card_charge', documentDate: org.date,
    custom: { controlAccountId: cardLiability },
    lines: [{ accountId: org.accounts.cogs, amount: '25', description: 'Supplies' }],
  },
  card_refund: {
    kind: 'card_refund', documentDate: org.date,
    lines: [{ accountId: org.accounts.cogs, amount: '10', description: 'Refund' }],
  },
  check: {
    kind: 'check', documentDate: org.date, referenceNumber: '1234',
    custom: { controlAccountId: org.accounts.bank },
    lines: [{ accountId: org.accounts.cogs, amount: '75', description: 'Rent' }],
  },
  deposit: {
    kind: 'deposit', documentDate: org.date,
    custom: { controlAccountId: org.accounts.bank },
    lines: [{ accountId: org.accounts.revenue, amount: '200', description: 'Cash' }],
  },
  transfer: {
    kind: 'transfer', documentDate: org.date,
    lines: [
      { accountId: org.accounts.bank, amount: '50' },
      { accountId: bank2, amount: '0' },
    ],
  },
})

const PREFIX: Record<string, string> = {
  customer_invoice: 'INV-', customer_credit: 'CM-', vendor_bill: 'BILL-', vendor_credit: 'VCRED-',
  card_charge: 'CC-', card_refund: 'CRF-', check: 'CHK-', deposit: 'DEP-', transfer: 'TRF-',
}

test('every supported kind creates a draft with a Save-allocated number', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org, bank2, cardLiability } = await setup()
  try {
    const all = bodies(org, bank2, cardLiability)
    await withOrgContext(org.orgId, async () => {
      for (const kind of Object.keys(all)) {
        const key = randomUUID()
        const before = await seqNext(org.orgId, kind)
        const response = await post(all[kind as keyof typeof all], key)
        assert.equal(response.status, 201, `${kind} → ${JSON.stringify(await response.clone().json())}`)
        const doc = (await response.json()) as { doc: Record<string, unknown> }
        assert.equal(doc.doc.kind, kind)
        assert.equal(doc.doc.status, 'draft')
        assert.equal(doc.doc.id, key)
        assert.ok(
          typeof doc.doc.document_number === 'string' && doc.doc.document_number.startsWith(PREFIX[kind]!),
          `${kind} number ${String(doc.doc.document_number)}`,
        )
        assert.ok(doc.doc.subsidiary_id, `${kind} carries a subsidiary`)
        assert.equal(doc.doc.currency, 'CAD')
        // The number allocates here on Save: the sequence advances exactly one.
        const after = await seqNext(org.orgId, kind)
        assert.equal(after, (before ?? 0) + 1, `${kind} sequence`)
      }
    })
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('first create emits exactly two audit events: insert image plus initialization-to-final update', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org, bank2, cardLiability } = await setup()
  try {
    const key = randomUUID()
    const all = bodies(org, bank2, cardLiability)
    let number = ''
    await withOrgContext(org.orgId, async () => {
      const response = await post(all.customer_invoice, key)
      assert.equal(response.status, 201)
      number = String(((await response.json()) as { doc: Record<string, unknown> }).doc.document_number)
    })
    const audits = await auditRows(org.orgId, key)
    assert.deepEqual(audits.map((a) => [a.action, a.requestId]), [
      ['insert', key],
      ['update', 'ui'],
    ])
    const insertAfter = (audits[0]!.changes as { after: Record<string, unknown> }).after
    assert.equal(insertAfter.kind, 'customer_invoice')
    assert.equal(insertAfter.document_number, number)
    assert.equal(insertAfter.status, 'draft')
    // The paired update shows initialization → final saved state.
    const updateChanges = audits[1]!.changes as { mode: string; after: { total: string } }
    assert.equal(updateChanges.mode, 'record_update')
    assert.equal(Number(updateChanges.after.total), 100)
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('exact replay returns 200 with no new rows and no sequence burn', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org, bank2, cardLiability } = await setup()
  try {
    const key = randomUUID()
    const all = bodies(org, bank2, cardLiability)
    let first: { doc: Record<string, unknown> }
    await withOrgContext(org.orgId, async () => {
      const created = await post(all.vendor_bill, key)
      assert.equal(created.status, 201)
      first = (await created.json()) as { doc: Record<string, unknown> }
    })
    const seqBefore = await seqNext(org.orgId, 'vendor_bill')
    const auditsBefore = await auditRows(org.orgId, key)
    await withOrgContext(org.orgId, async () => {
      const replayed = await post(all.vendor_bill, key)
      assert.equal(replayed.status, 200)
      const again = (await replayed.json()) as { doc: Record<string, unknown> }
      assert.equal(again.doc.id, key)
      assert.equal(again.doc.document_number, first!.doc.document_number)
    })
    assert.equal(await seqNext(org.orgId, 'vendor_bill'), seqBefore, 'replay burns no number')
    assert.equal((await auditRows(org.orgId, key)).length, auditsBefore.length, 'replay writes no audit')
    assert.equal(await docCount(org.orgId, key), 1)
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('changed payload on the same key is a 409 and changes nothing', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org, bank2, cardLiability } = await setup()
  try {
    const key = randomUUID()
    const all = bodies(org, bank2, cardLiability)
    await withOrgContext(org.orgId, async () => {
      assert.equal((await post(all.check, key)).status, 201)
      const changed = { ...all.check, referenceNumber: '9999' }
      const conflict = await post(changed, key)
      assert.equal(conflict.status, 409)
      assert.deepEqual(await conflict.json(), { error: 'invalid_idempotency_key' })
    })
    const audits = await auditRows(org.orgId, key)
    assert.equal(audits.length, 2, 'conflict writes no audit')
    const doc = await withBypassContext(async () =>
      (await db.execute<{ n: string }>(sql`select reference_number as n from documents where id = ${key} and org_id = ${org.orgId}`)).rows[0],
    )
    assert.equal(doc?.n, '1234', 'original row untouched')
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('cross-org key collision is a 409 that discloses nothing', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org, bank2, cardLiability } = await setup()
  const other = await withBypassContext(() => createScratchOrg())
  try {
    const key = randomUUID()
    await withBypassContext(async () => {
      await db.execute(sql`
        insert into documents (id, org_id, kind, status, document_number, subsidiary_id, document_date, currency, subtotal, tax_total, total, created_by)
        values (${key}, ${other.orgId}, 'vendor_bill', 'draft', 'BILL-X', ${other.subsidiaryId}, ${other.date}, 'CAD', '0', '0', '0', ${other.orgId})`)
    })
    const all = bodies(org, bank2, cardLiability)
    await withOrgContext(org.orgId, async () => {
      const response = await post(all.vendor_bill, key)
      assert.equal(response.status, 409)
      assert.deepEqual(await response.json(), { error: 'invalid_idempotency_key' })
    })
    assert.equal(await docCount(org.orgId, key), 0, 'no row claimed in this org')
    assert.equal((await auditRows(org.orgId, key)).length, 0, 'no audit in this org')
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
    await withBypassContext(() => dropScratchOrg(other.orgId))
  }
})

test('late writer failure rolls back everything: zero row, zero audit, zero sequence, reusable key', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org, bank2, cardLiability } = await setup()
  try {
    const key = randomUUID()
    const all = bodies(org, bank2, cardLiability)
    // A foreign line account passes every route precheck and fails deep in
    // the shared writer — after the claim, number, and audit would have
    // committed in a non-atomic design.
    const bad = {
      ...all.customer_invoice,
      lines: [{ accountId: randomUUID(), amount: '100', description: 'Ghost' }],
    }
    const seqBefore = await seqNext(org.orgId, 'customer_invoice')
    await withOrgContext(org.orgId, async () => {
      const refused = await post(bad, key)
      assert.equal(refused.status, 404)
      assert.deepEqual(await refused.json(), { error: 'account not found in this organization' })
    })
    assert.equal(await docCount(org.orgId, key), 0, 'no document row')
    assert.equal((await auditRows(org.orgId, key)).length, 0, 'no audit insert')
    assert.equal(await seqNext(org.orgId, 'customer_invoice'), seqBefore, 'no sequence burn')
    // The key was never claimed: the corrected request proceeds as fresh.
    await withOrgContext(org.orgId, async () => {
      const retried = await post(all.customer_invoice, key)
      assert.equal(retried.status, 201, JSON.stringify(await retried.clone().json()))
    })
    assert.equal(await docCount(org.orgId, key), 1)
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('pre-transaction provider/shape refusal writes nothing', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org, bank2, cardLiability } = await setup()
  try {
    const key = randomUUID()
    const all = bodies(org, bank2, cardLiability)
    const bad = {
      ...all.vendor_bill,
      lines: [{ accountId: org.accounts.cogs, amount: 'not-an-amount', description: 'Bad' }],
    }
    await withOrgContext(org.orgId, async () => {
      const refused = await post(bad, key)
      assert.equal(refused.status, 422)
    })
    assert.equal(await docCount(org.orgId, key), 0, 'no document row')
    assert.equal((await auditRows(org.orgId, key)).length, 0, 'no audit insert')
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('tenant and field refusals name the remedy with exact drawer messages', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org, bank2, cardLiability } = await setup()
  const other = await withBypassContext(() => createScratchOrg())
  try {
    const all = bodies(org, bank2, cardLiability)
    await withOrgContext(org.orgId, async () => {
      // Missing party on a party-role kind.
      let response = await post({ ...all.customer_invoice, partyId: null }, randomUUID())
      assert.equal(response.status, 422)
      assert.match((await response.json() as { error: string }).error, /requires a customer/)
      // Malformed header date.
      response = await post({ ...all.vendor_bill, documentDate: '2026-13-99' }, randomUUID())
      assert.equal(response.status, 422)
      assert.match((await response.json() as { error: string }).error, /invalid documentDate/)
      // Another tenant's party.
      response = await post({ ...all.customer_invoice, partyId: other.customerId }, randomUUID())
      assert.equal(response.status, 404)
      assert.deepEqual(await response.json(), { error: 'party not found in this organization' })
      // Another tenant's line account.
      response = await post(
        { ...all.vendor_bill, lines: [{ accountId: other.accounts.cogs, amount: '5' }] },
        randomUUID(),
      )
      assert.equal(response.status, 404)
      assert.deepEqual(await response.json(), { error: 'account not found in this organization' })
      // Unknown subsidiary.
      response = await post({ ...all.vendor_bill, subsidiaryId: randomUUID() }, randomUUID())
      assert.equal(response.status, 422)
      assert.deepEqual(await response.json(), { error: 'invalid subsidiary' })
      // Explicit null subsidiary.
      response = await post({ ...all.vendor_bill, subsidiaryId: null }, randomUUID())
      assert.equal(response.status, 422)
      assert.match((await response.json() as { error: string }).error, /requires a subsidiary/)
      // Missing line account names its line.
      response = await post(
        { ...all.vendor_bill, lines: [{ amount: '5', description: 'No account' }] },
        randomUUID(),
      )
      assert.equal(response.status, 422)
      assert.match((await response.json() as { error: string }).error, /Line 1: an account is required/)
    })
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
    await withBypassContext(() => dropScratchOrg(other.orgId))
  }
})

test('omitted currency uses the org base with multi-currency off; explicit currency stays gated', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org, bank2, cardLiability } = await setup()
  try {
    const all = bodies(org, bank2, cardLiability)
    await withOrgContext(org.orgId, async () => {
      const plain = await post(all.customer_invoice, randomUUID())
      assert.equal(plain.status, 201, JSON.stringify(await plain.clone().json()))
      assert.equal(((await plain.json()) as { doc: Record<string, unknown> }).doc.currency, 'CAD')
      // An explicit currency is a user currency change: governed by the
      // existing multi-currency feature policy, exactly like PATCH.
      const gated = await post({ ...all.customer_invoice, currency: 'USD' }, randomUUID())
      assert.equal(gated.status, 404)
      assert.deepEqual(await gated.json(), { error: 'not found' })
    })
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

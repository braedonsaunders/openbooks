import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    return next(specifier, context)
  },
})

const { sql } = await import('drizzle-orm')
const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { journalReport, generalLedger } = await import('./reports/ledger-reports.ts')
const { transactionDetail } = await import('./reports/transaction-detail.ts')
const { accountRegister, partyRegister, partnerStatement } = await import('./reports/registers.ts')
const { entryDetail } = await import('./data.ts')
const { executeReport } = await import('./custom-reports.ts')
const { withReportAuthz } = await import('./report-execution-context.ts')
const { PAYROLL_RESTRICTED_PARTY_LABEL } = await import('./payroll-confidentiality.ts')
import type { Authz } from './authz.ts'

/**
 * PAYCONF: a reader with reports.read but WITHOUT payroll.read must not see
 * per-employee net pay through any ledger surface, while every total still
 * balances and payroll.read holders keep full detail.
 *
 * The fixture mirrors what the payroll engine posts: a pay-run projection
 * (origin 'document', source document kind pay_run) with per-employee
 * party-tagged net-pay credits, and a net-pay settlement (origin 'payroll',
 * same source document) with per-employee debits and cheque memos. The
 * net-pay payable is a `liability_payable` account — expressly allowed by the
 * payroll settings contract — so the AP register path is exercised too. A
 * vendor bill on the same control proves non-payroll party detail is
 * untouched.
 */

const ALICE = 'Alice Anderson'
const BOB = 'Bob Brown'

async function seed() {
  const scratch = await withBypass(() => createScratchOrg())
  const actor = await withBypass(() => createScratchUser(scratch.orgId, 'Payconf Controller', 'admin'))
  const fx = {
    ...scratch, actor,
    alice: randomUUID(), bob: randomUUID(),
    payRun: randomUUID(), bill: randomUUID(),
    e1: randomUUID(), e2: randomUUID(), e3: randomUUID(),
    wages: randomUUID(),
  }
  await withBypass(async () => {
    await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id)
      values (${fx.alice}, ${fx.orgId}, 'employee', ${ALICE}, ${fx.subsidiaryId}),
             (${fx.bob}, ${fx.orgId}, 'employee', ${BOB}, ${fx.subsidiaryId})`)
    await db.execute(sql`insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
      values (${fx.wages}, ${fx.orgId}, '6000', 'Wages', 'expense', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`)
    await db.execute(sql`insert into documents
      (id, org_id, kind, status, document_number, subsidiary_id, document_date, currency, fx_rate, subtotal, tax_total, total, created_by)
      values (${fx.payRun}, ${fx.orgId}, 'pay_run', 'approved', 'PAY-001', ${fx.subsidiaryId}, ${fx.date}, 'CAD', '1', 0, 0, 0, ${fx.actor}),
             (${fx.bill}, ${fx.orgId}, 'vendor_bill', 'approved', 'BILL-1', ${fx.subsidiaryId}, ${fx.date}, 'CAD', '1', 300, 0, 300, ${fx.actor})`)
    const entry = (id: string, number: string, origin: string, source: string) => db.execute(sql`insert into journal_entries
      (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, source_document_id)
      values (${id}, ${fx.orgId}, ${fx.bookId}, ${fx.subsidiaryId}, ${number}, ${fx.date}, ${fx.periodId}, ${number}, 'draft', ${origin}, ${source})`)
    await entry(fx.e1, 'JE-PAYRUN', 'document', fx.payRun)
    await entry(fx.e2, 'JE-PAYD', 'payroll', fx.payRun)
    await entry(fx.e3, 'JE-BILL', 'document', fx.bill)
    // E1: run projection — wage debit, aggregate tax credit, per-employee net-pay credits.
    await db.execute(sql`insert into journal_lines
      (org_id, entry_id, line_number, account_id, subsidiary_id, party_id, amount, currency, txn_amount, fx_rate, is_open_item, memo)
      values (${fx.orgId}, ${fx.e1}, 1, ${fx.wages}, ${fx.subsidiaryId}, null, '5000', 'CAD', '5000', '1', false, 'Wages'),
             (${fx.orgId}, ${fx.e1}, 2, ${fx.accounts.taxOutput}, ${fx.subsidiaryId}, null, '-1000', 'CAD', '-1000', '1', false, 'Tax'),
             (${fx.orgId}, ${fx.e1}, 3, ${fx.accounts.ap}, ${fx.subsidiaryId}, ${fx.alice}, '-1500', 'CAD', '-1500', '1', true, 'Net pay'),
             (${fx.orgId}, ${fx.e1}, 4, ${fx.accounts.ap}, ${fx.subsidiaryId}, ${fx.bob}, '-2500', 'CAD', '-2500', '1', true, 'Net pay')`)
    // E2: settlement — per-employee debits with cheque memos, one bank credit.
    await db.execute(sql`insert into journal_lines
      (org_id, entry_id, line_number, account_id, subsidiary_id, party_id, amount, currency, txn_amount, fx_rate, is_open_item, memo)
      values (${fx.orgId}, ${fx.e2}, 1, ${fx.accounts.ap}, ${fx.subsidiaryId}, ${fx.alice}, '1500', 'CAD', '1500', '1', true, 'Net pay PAY-001 · cheque 101'),
             (${fx.orgId}, ${fx.e2}, 2, ${fx.accounts.ap}, ${fx.subsidiaryId}, ${fx.bob}, '2500', 'CAD', '2500', '1', true, 'Net pay PAY-001 · cheque 102'),
             (${fx.orgId}, ${fx.e2}, 3, ${fx.accounts.bank}, ${fx.subsidiaryId}, null, '-4000', 'CAD', '-4000', '1', false, 'Net pay PAY-001')`)
    // E3: ordinary vendor bill — must never be masked.
    await db.execute(sql`insert into journal_lines
      (org_id, entry_id, line_number, account_id, subsidiary_id, party_id, amount, currency, txn_amount, fx_rate, is_open_item, memo)
      values (${fx.orgId}, ${fx.e3}, 1, ${fx.accounts.freight}, ${fx.subsidiaryId}, ${fx.vendorId}, '300', 'CAD', '300', '1', false, 'Freight'),
             (${fx.orgId}, ${fx.e3}, 2, ${fx.accounts.ap}, ${fx.subsidiaryId}, ${fx.vendorId}, '-300', 'CAD', '-300', '1', true, 'Freight')`)
    await db.execute(sql`update journal_entries set status = 'posted', posted_at = now()
      where org_id = ${fx.orgId} and id in (${fx.e1}, ${fx.e2}, ${fx.e3})`)
    await db.execute(sql`update documents set status = 'posted', posted_entry_id = ${fx.e1}, posting_period_id = ${fx.periodId}
      where id = ${fx.payRun} and org_id = ${fx.orgId}`)
    await db.execute(sql`update documents set status = 'posted', posted_entry_id = ${fx.e3}, posting_period_id = ${fx.periodId}
      where id = ${fx.bill} and org_id = ${fx.orgId}`)
  })
  return fx
}

function readerAuthz(fx: Awaited<ReturnType<typeof seed>>, permissions: string[]): Authz {
  return {
    user: {
      id: fx.actor, email: 'payconf@example.com', name: 'Payconf', roles: [],
      orgId: fx.orgId, envKind: 'production', productionOrgId: fx.orgId,
      isSuperAdmin: false, homeUserId: fx.actor, homeOrgId: fx.orgId,
    },
    permissions: new Set(permissions),
    allowedSubsidiaryIds: null,
  } as Authz
}

test('journal hides per-employee pay but balances; payroll.read keeps detail', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const fx = await seed()
  try {
    const { masked, full } = await withOrgContext(fx.orgId, async () => ({
      masked: await journalReport(fx.date, fx.date, { orgId: fx.orgId }),
      full: await journalReport(fx.date, fx.date, { orgId: fx.orgId, canSeePayroll: true }),
    }))
    const maskedText = JSON.stringify(masked)
    assert.ok(!maskedText.includes(ALICE) && !maskedText.includes(BOB), 'no employee names for restricted readers')
    assert.ok(!maskedText.includes('cheque'), 'no per-employee cheque memos for restricted readers')
    const e1 = masked.entries.find((e) => e.entryNumber === 'JE-PAYRUN')!
    const e2 = masked.entries.find((e) => e.entryNumber === 'JE-PAYD')!
    assert.equal(e1.totalDebit, '5000.0000')
    assert.equal(e2.totalDebit, '4000.0000')
    const e1Pay = e1.lines.filter((l) => l.accountName === 'Accounts Payable')
    assert.equal(e1Pay.length, 1)
    assert.equal(e1Pay[0]?.party, PAYROLL_RESTRICTED_PARTY_LABEL)
    assert.equal(e1Pay[0]?.memo, null)
    assert.equal(e1Pay[0]?.credit, '4000.0000')
    const e2Pay = e2.lines.filter((l) => l.accountName === 'Accounts Payable')
    assert.equal(e2Pay.length, 1)
    assert.equal(e2Pay[0]?.party, PAYROLL_RESTRICTED_PARTY_LABEL)
    assert.equal(e2Pay[0]?.debit, '4000.0000')
    // The vendor bill next door is untouched.
    const e3 = masked.entries.find((e) => e.entryNumber === 'JE-BILL')!
    assert.ok(e3.lines.every((l) => l.party !== null && l.party !== PAYROLL_RESTRICTED_PARTY_LABEL))
    // Full detail survives behind payroll.read.
    assert.ok(JSON.stringify(full).includes(ALICE) && JSON.stringify(full).includes('cheque 101'))
    assert.equal(full.entries.find((e) => e.entryNumber === 'JE-PAYRUN')!.lines.filter((l) => l.accountName === 'Accounts Payable').length, 2)
  } finally {
    await withBypass(() => dropScratchOrg(fx.orgId))
  }
})

test('general ledger collapses payroll lines with exact balances', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const fx = await seed()
  try {
    const { masked, full } = await withOrgContext(fx.orgId, async () => ({
      masked: await generalLedger(fx.date, fx.date, { orgId: fx.orgId, accountId: fx.accounts.ap }),
      full: await generalLedger(fx.date, fx.date, { orgId: fx.orgId, accountId: fx.accounts.ap, canSeePayroll: true }),
    }))
    assert.equal(masked.accounts.length, 1)
    // E1 pair -> 1 line, E2 pair -> 1 line, vendor bill -> 1 line.
    assert.equal(masked.accounts[0]?.lines.length, 3)
    assert.equal(full.accounts[0]?.lines.length, 5)
    assert.equal(masked.accounts[0]?.closing, full.accounts[0]?.closing)
    assert.equal(masked.accounts[0]?.closing, '-300.0000')
    assert.ok(!JSON.stringify(masked).includes(ALICE) && !masked.accounts[0]?.lines.some((l) => l.memo?.includes('cheque')))
    assert.ok(masked.accounts[0]?.lines.some((l) => l.party === PAYROLL_RESTRICTED_PARTY_LABEL))
    assert.ok(JSON.stringify(full).includes(ALICE))
  } finally {
    await withBypass(() => dropScratchOrg(fx.orgId))
  }
})

test('statement drill ties out with masked lines; payroll.read keeps detail', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const fx = await seed()
  try {
    const { masked, full } = await withOrgContext(fx.orgId, async () => ({
      masked: await transactionDetail({ accountIds: [fx.accounts.ap], from: fx.date, to: fx.date, mode: 'flow', orgId: fx.orgId }),
      full: await transactionDetail({ accountIds: [fx.accounts.ap], from: fx.date, to: fx.date, mode: 'flow', orgId: fx.orgId, canSeePayroll: true }),
    }))
    assert.equal(masked.net, full.net)
    assert.equal(masked.totalDebit, full.totalDebit)
    assert.equal(masked.totalCredit, full.totalCredit)
    assert.equal(masked.lines.length, 3)
    assert.equal(full.lines.length, 5)
    assert.ok(!JSON.stringify(masked).includes(ALICE) && !JSON.stringify(masked).includes('cheque'))
    assert.ok(JSON.stringify(full).includes(BOB))
  } finally {
    await withBypass(() => dropScratchOrg(fx.orgId))
  }
})

test('account register masks payroll lines with an unchanged balance', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const fx = await seed()
  try {
    const { masked, full } = await withOrgContext(fx.orgId, async () => ({
      masked: await accountRegister(fx.orgId, fx.accounts.ap, 100, 0),
      full: await accountRegister(fx.orgId, fx.accounts.ap, 100, 0, undefined, null, undefined, true),
    }))
    assert.equal(masked.balance, '-300.0000')
    assert.equal(masked.balance, full.balance)
    assert.ok(!JSON.stringify(masked).includes(ALICE) && !JSON.stringify(masked).includes('cheque'))
    assert.ok(masked.lines.some((l) => l.party === PAYROLL_RESTRICTED_PARTY_LABEL))
    assert.ok(JSON.stringify(full).includes(ALICE))
    // No party ids leak through the collapsed rows.
    assert.ok(!JSON.stringify(masked).includes(fx.alice) && !JSON.stringify(masked).includes(fx.bob))
  } finally {
    await withBypass(() => dropScratchOrg(fx.orgId))
  }
})

test('entry detail collapses payroll lines; payroll.read keeps detail', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const fx = await seed()
  try {
    const { masked, full } = await withOrgContext(fx.orgId, async () => ({
      masked: await entryDetail(fx.orgId, fx.e2),
      full: await entryDetail(fx.orgId, fx.e2, null, true),
    }))
    assert.ok(masked.entry)
    assert.equal(masked.lines.length, 2)
    const pay = masked.lines.find((l) => l.account_name === 'Accounts Payable')!
    assert.equal(pay.party, PAYROLL_RESTRICTED_PARTY_LABEL)
    assert.equal(pay.memo, null)
    assert.equal(pay.amount, '4000.0000')
    assert.ok(!JSON.stringify(masked).includes(ALICE) && !JSON.stringify(masked).includes('cheque'))
    assert.ok(!JSON.stringify(masked).includes(fx.alice))
    assert.equal(full.lines.length, 3)
    assert.ok(JSON.stringify(full).includes('cheque 102'))
  } finally {
    await withBypass(() => dropScratchOrg(fx.orgId))
  }
})

test('AP register remaps payroll parties with control-tying closings', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const fx = await seed()
  try {
    const { masked, full } = await withOrgContext(fx.orgId, async () => ({
      masked: await partyRegister('ap', { from: fx.date, to: fx.date, orgId: fx.orgId }),
      full: await partyRegister('ap', { from: fx.date, to: fx.date, orgId: fx.orgId, canSeePayroll: true }),
    }))
    const names = masked.parties.map((p) => p.partyName)
    assert.ok(!names.includes(ALICE) && !names.includes(BOB), 'no employee sections for restricted readers')
    const total = (parties: typeof masked.parties): number =>
      parties.reduce((n, p) => n + Number(p.closing), 0)
    assert.equal(total(masked.parties), total(full.parties))
    assert.equal(total(masked.parties), -300)
    // The vendor section survives intact; the masked amounts sit unassigned.
    const vendor = masked.parties.find((p) => p.partyName !== null && p.partyId !== null)!
    assert.equal(vendor.closing, '-300.0000')
    const unassigned = masked.parties.find((p) => p.partyId === null)!
    assert.equal(unassigned.closing, '0.0000')
    // Full detail keeps per-employee sections that net to zero (settled).
    const alice = full.parties.find((p) => p.partyName === ALICE)!
    assert.equal(alice.lines.length, 2)
    assert.equal(alice.closing, '0.0000')
  } finally {
    await withBypass(() => dropScratchOrg(fx.orgId))
  }
})

test('partner statement excludes payroll from the employee statement', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const fx = await seed()
  try {
    const { masked, full, vendorMasked } = await withOrgContext(fx.orgId, async () => ({
      masked: await partnerStatement(fx.alice, fx.orgId, { from: fx.date, to: fx.date, side: 'ap' }),
      full: await partnerStatement(fx.alice, fx.orgId, { from: fx.date, to: fx.date, side: 'ap', canSeePayroll: true }),
      vendorMasked: await partnerStatement(fx.vendorId, fx.orgId, { from: fx.date, to: fx.date, side: 'ap' }),
    }))
    assert.equal(masked.lines.length, 0)
    assert.equal(Number(masked.opening), 0)
    assert.equal(Number(masked.closing), 0)
    assert.equal(full.lines.length, 2)
    // The vendor statement is unaffected by the remap.
    assert.equal(vendorMasked.lines.length, 1)
    assert.equal(vendorMasked.closing, '-300.0000')
  } finally {
    await withBypass(() => dropScratchOrg(fx.orgId))
  }
})

test('report-builder ledger lines mask identity and collapse payroll rows', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const fx = await seed()
  try {
    const columns = ['posting_date', 'entry_number', 'account_name', 'party_name', 'memo', 'amount', 'entry_id', 'account_id']
    const run = (permissions: string[]) =>
      withReportAuthz(readerAuthz(fx, permissions), () =>
        withOrgContext(fx.orgId, () =>
          // Empty labels: the Next request-scoped label localizer is
          // unavailable in tests; every hook is optional.
          executeReport(fx.orgId, { entity: 'ledger_lines', mode: 'rows', columns }, undefined, {})))
    const [masked, full] = await Promise.all([
      run(['reports.read']),
      run(['reports.read', 'payroll.read']),
    ])
    const maskedText = JSON.stringify(masked)
    assert.ok(!maskedText.includes(ALICE) && !maskedText.includes(BOB), 'no employee names in builder output')
    assert.ok(!maskedText.includes('cheque'), 'no cheque memos in builder output')
    assert.ok(!maskedText.includes(fx.alice), 'no employee ids in builder output')
    assert.ok(maskedText.includes(PAYROLL_RESTRICTED_PARTY_LABEL))
    const group = masked.groups[0]!
    const partyIdx = columns.indexOf('party_name')
    const amountIdx = columns.indexOf('amount')
    const entryIdx = columns.indexOf('entry_id')
    const payRows = group.rows.filter((row) => row[partyIdx] === PAYROLL_RESTRICTED_PARTY_LABEL)
    // One collapsed row per payroll (entry, account): E1-AP and E2-AP.
    assert.equal(payRows.length, 2)
    const e1 = payRows.find((row) => row[entryIdx] === fx.e1)!
    const e2 = payRows.find((row) => row[entryIdx] === fx.e2)!
    assert.equal(Number(e1[amountIdx]), -4000)
    assert.equal(Number(e2[amountIdx]), 4000)
    // Money still ties between the two grants.
    const sum = (rows: (string | number | null | undefined)[][]): number =>
      rows.reduce((n, row) => n + (row[amountIdx] == null ? 0 : Number(row[amountIdx])), 0)
    assert.equal(sum(group.rows), sum(full.groups[0]!.rows))
    // Full detail behind payroll.read.
    assert.ok(JSON.stringify(full).includes(ALICE))
    assert.ok(full.groups[0]!.rows.length > group.rows.length)
    // The vendor row keeps its party in both.
    assert.ok(group.rows.some((row) => String(row[partyIdx] ?? '').length > 0 && row[partyIdx] !== PAYROLL_RESTRICTED_PARTY_LABEL))
  } finally {
    await withBypass(() => dropScratchOrg(fx.orgId))
  }
})

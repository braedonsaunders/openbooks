import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  return next(specifier, context)
} })
const { sql } = await import('drizzle-orm')
const { db, env } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { importStatement, startReconciliation } = await import('@openbooks/engine/src/banking/banking.ts')
const { ScopeNotFoundError } = await import('@openbooks/engine/src/organization/subsidiary-scope.ts')
const {
  addJournalMatchFromLine,
  applyRuleToLine,
  applyRulesToAccount,
  ensureOpenReconciliation,
  previewRules,
} = await import('./banking-rules.ts')

// Bank-rule services inherit the banking subsidiary boundary: every entry
// point that resolves an account or a statement line refuses an out-of-scope
// target with the uniform not-found before reading rules or touching the
// ledger.

interface Fixture {
  orgId: string
  actor: string
  date: string
  subA: string
  subB: string
  bankA: string
  bankB: string
  lineA: string
}

async function fixture(): Promise<Fixture> {
  const org = await createScratchOrg()
  const actor = (await seedFlowActors(org.orgId)).adminId
  const subB = randomUUID()
  await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
    values (${subB}, ${org.orgId}, ${org.subsidiaryId}, 'Second entity', 'CAD', 'CA')`)
  const bankB = randomUUID()
  await db.execute(sql`insert into accounts
    (id, org_id, number, name, type, is_summary, is_active, eliminate,
     reconcilable, required_dimensions, custom, subsidiary_include_children,
     subsidiary_id, currency_restriction)
    values (${bankB}, ${org.orgId}, '1011', 'Second entity bank', 'asset_bank',
     false, true, false, true, '[]'::jsonb, '{}'::jsonb, true, ${subB}, 'CAD')`)
  await db.execute(sql`update accounts set reconcilable = true, currency_restriction = 'CAD',
    subsidiary_id = ${org.subsidiaryId} where id = ${org.accounts.bank} and org_id = ${org.orgId}`)
  const nonce = randomUUID().slice(0, 8)
  await importStatement(
    {
      accountId: org.accounts.bank,
      source: 'ofx',
      statementDate: org.date,
      openingBalance: '0',
      closingBalance: '33',
      currency: 'CAD',
      lines: [{
        postedOn: org.date,
        amount: '33',
        description: 'Scope probe deposit',
        bankTransactionId: `scope-lib-${nonce}`,
      }],
    },
    { orgId: org.orgId, userId: actor, allowedSubsidiaryIds: null },
  )
  const lineA = (await db.execute<{ id: string }>(sql`
    select id from bank_statement_lines where org_id = ${org.orgId} and account_id = ${org.accounts.bank}
  `)).rows[0]!.id
  return { orgId: org.orgId, actor, date: org.date, subA: org.subsidiaryId, subB, bankA: org.accounts.bank, bankB, lineA }
}

async function seedExcludeRule(orgId: string, actor: string): Promise<string> {
  const ruleId = randomUUID()
  await db.execute(sql`
    insert into bank_match_rules (id, org_id, name, criteria, outcome, priority, is_active, created_by)
    values (${ruleId}, ${orgId}, 'Scope probe excluder',
      '{"version":2,"match":{"combinator":"and","rules":[{"field":"description","op":"contains","value":"Scope probe"}]}}'::jsonb,
      '{"action":"exclude"}'::jsonb, 100, true, ${actor})`)
  return ruleId
}

async function assertUniformNotFound(promise: Promise<unknown>): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    if (!(error instanceof ScopeNotFoundError)) return false
    return error.status === 404 && error.message === 'not found'
  })
}

test('ensureOpenReconciliation refuses an out-of-scope account before creating', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const fx = await fixture()
  try {
    await assertUniformNotFound(ensureOpenReconciliation(fx.orgId, fx.actor, fx.bankA, new Set([fx.subB])))
    const sessions = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from reconciliations where org_id = ${fx.orgId}`)).rows[0]!.n
    assert.equal(sessions, 0)
    const id = await ensureOpenReconciliation(fx.orgId, fx.actor, fx.bankA, new Set([fx.subA]))
    assert.ok(id)
  } finally { await dropScratchOrg(fx.orgId) }
})

test('applyRulesToAccount refuses an out-of-scope account without touching lines', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const fx = await fixture()
  try {
    await seedExcludeRule(fx.orgId, fx.actor)
    await assertUniformNotFound(applyRulesToAccount(fx.orgId, fx.actor, fx.bankA, new Set([fx.subB])))
    const status = (await db.execute<{ s: string }>(sql`
      select match_status as s from bank_statement_lines where id = ${fx.lineA}`)).rows[0]!.s
    assert.equal(status, 'unmatched')
    const applied = await applyRulesToAccount(fx.orgId, fx.actor, fx.bankA, new Set([fx.subA]))
    assert.equal(applied.excluded, 1)
  } finally { await dropScratchOrg(fx.orgId) }
})

test('applyRuleToLine refuses an out-of-scope statement line', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const fx = await fixture()
  try {
    const ruleId = await seedExcludeRule(fx.orgId, fx.actor)
    await assertUniformNotFound(
      applyRuleToLine(fx.orgId, fx.actor, { statementLineId: fx.lineA, ruleId }, new Set([fx.subB])),
    )
    await applyRuleToLine(fx.orgId, fx.actor, { statementLineId: fx.lineA, ruleId }, new Set([fx.subA]))
    const status = (await db.execute<{ s: string }>(sql`
      select match_status as s from bank_statement_lines where id = ${fx.lineA}`)).rows[0]!.s
    assert.equal(status, 'excluded')
  } finally { await dropScratchOrg(fx.orgId) }
})

test('addJournalMatchFromLine refuses out-of-scope line and offset accounts', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const fx = await fixture()
  try {
    const session = await startReconciliation(
      { accountId: fx.bankA, throughDate: fx.date, statementBalance: '33' },
      { orgId: fx.orgId, userId: fx.actor, allowedSubsidiaryIds: null },
    )
    // Out-of-scope line: the session never matters.
    await assertUniformNotFound(
      addJournalMatchFromLine(
        fx.orgId, fx.actor,
        { statementLineId: fx.lineA, offsetAccountId: fx.bankA, reconciliationId: session.id },
        new Set([fx.subB]),
      ),
    )
    // In-scope line but another entity's offset account.
    await assertUniformNotFound(
      addJournalMatchFromLine(
        fx.orgId, fx.actor,
        { statementLineId: fx.lineA, offsetAccountId: fx.bankB, reconciliationId: session.id },
        new Set([fx.subA]),
      ),
    )
    const status = (await db.execute<{ s: string }>(sql`
      select match_status as s from bank_statement_lines where id = ${fx.lineA}`)).rows[0]!.s
    assert.equal(status, 'unmatched')
  } finally { await dropScratchOrg(fx.orgId) }
})

test('previewRules refuses an out-of-scope account without reading lines', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const fx = await fixture()
  try {
    await assertUniformNotFound(
      previewRules(fx.orgId, fx.bankA, { onlyUnmatched: true, allowedSubsidiaryIds: new Set([fx.subB]) }),
    )
    const preview = await previewRules(fx.orgId, fx.bankA, { onlyUnmatched: true, allowedSubsidiaryIds: new Set([fx.subA]) })
    assert.equal(preview.scanned, 1)
  } finally { await dropScratchOrg(fx.orgId) }
})

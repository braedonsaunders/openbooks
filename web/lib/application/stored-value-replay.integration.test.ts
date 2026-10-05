import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { sql } from 'drizzle-orm'

const { redeemStoredValueForInvoice } = await import('./stored-value.ts')
const { ApplicationError } = await import('./errors.ts')
const { db, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg, seedPostingAccount } = await import(
  '@openbooks/engine/src/testing/fixtures.ts',
)
const { actorAllowedSubsidiaryIds } = await import('@openbooks/engine/src/organization/actor-subsidiaries.ts')
const { createProgram, issueStoredValue } = await import('@openbooks/engine/src/stored-value/accounts.ts')
const { postDocument } = await import('@openbooks/engine/src/ledger/posting-document.ts')
const { toUnits } = await import('@openbooks/engine/src/money/money.ts')

const DB = !!process.env.OPENBOOKS_DB_URL

interface ReplayFixture {
  orgId: string
  subsidiaryId: string
  secondId: string
  date: string
  bank: string
  ar: string
  ap: string
  revenue: string
  customerId: string
  giftProgram: string
  actorId: string
  rootActor: string
  codeA: string
  codeB: string
  accountA: string
  accountB: string
}

async function seedReplayOrg(): Promise<ReplayFixture> {
  const org = await createScratchOrg()
  const actorId = await withBypass(() => createScratchUser(org.orgId, 'SV App', 'sv_app'))
  const liability = await withBypass(() =>
    seedPostingAccount(org.orgId, '2600', 'Gift card liability', 'liability_current_other'),
  )
  const breakageIncome = await withBypass(() =>
    seedPostingAccount(org.orgId, '4900', 'Breakage income', 'income_other'),
  )
  await withBypass(() =>
    db.execute(sql`
      update orgs set settings = settings
        || jsonb_build_object('features', coalesce(settings->'features', '{}'::jsonb) || '{"storedValue": true}'::jsonb)
       where id = ${org.orgId}`),
  )
  const secondId = (await withBypass(() => db.execute<{ id: string }>(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    select ${randomUUID()}, ${org.orgId}, s.id, 'Second Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb
      from subsidiaries s where s.org_id = ${org.orgId} and s.parent_id is null limit 1 returning id`))).rows[0]!.id
  const program = await withBypass(() =>
    createProgram({
      orgId: org.orgId,
      name: 'App gift cards',
      kind: 'gift_card',
      liabilityAccountId: liability,
      breakageIncomeAccountId: breakageIncome,
      breakagePolicy: 'none',
      actorId,
    }),
  )
  const mint = async (key: string) =>
    withBypass(() =>
      issueStoredValue({
        orgId: org.orgId,
        allowedSubsidiaryIds: null,
        subsidiaryId: org.subsidiaryId,
        programId: program.id,
        amountMinor: toUnits('100'),
        currency: 'CAD',
        debitAccountId: org.accounts.bank,
        postingDate: org.date,
        idempotencyKey: key,
        actorId,
      }),
    )
  const cardA = await mint(`app-replay-a-${randomUUID()}`)
  const cardB = await mint(`app-replay-b-${randomUUID()}`)
  assert.ok(cardA.code && cardB.code, 'both cards show their codes once at issuance')
  const rootActor = await withBypass(() => createScratchUser(org.orgId, 'SV App Root', 'sv_app_root'))
  await withBypass(() =>
    db.execute(sql`
      update app_roles set permissions = '["stored_value.read","stored_value.manage"]'::jsonb,
        subsidiary_restriction = ${JSON.stringify({ mode: 'list', subsidiaryIds: [org.subsidiaryId] })}::jsonb
       where org_id = ${org.orgId} and key = 'sv_app_root'`),
  )
  return {
    orgId: org.orgId,
    subsidiaryId: org.subsidiaryId,
    secondId,
    date: org.date,
    bank: org.accounts.bank,
    ar: org.accounts.ar,
    ap: org.accounts.ap,
    revenue: org.accounts.revenue,
    customerId: org.customerId,
    giftProgram: program.id,
    actorId,
    rootActor,
    codeA: cardA.code!,
    codeB: cardB.code!,
    accountA: cardA.accountId,
    accountB: cardB.accountId,
  }
}

/** Post one open CAD invoice in the root entity through the real posting path. */
async function postRootInvoice(fx: ReplayFixture, amount: string): Promise<string> {
  const id = randomUUID()
  await withBypass(async () => {
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, currency, fx_rate, subtotal, tax_total, total, created_by)
      values (${id}, ${fx.orgId}, 'customer_invoice', 'draft', ${`APP-${id.slice(0, 8)}`},
              ${fx.subsidiaryId}, ${fx.customerId}, ${fx.date}, 'CAD', '1',
              ${amount}, '0', ${amount}, ${fx.actorId})`)
    await db.execute(sql`
      insert into document_lines
        (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount)
      values (${fx.orgId}, ${id}, 1, ${fx.revenue}, '1', ${amount}, ${amount}, '0')`)
    await db.execute(sql`
      update documents set status = 'approved', updated_at = now()
       where id = ${id} and org_id = ${fx.orgId}`)
  })
  await withBypass(() =>
    postDocument(id, { control: { ar: fx.ar, ap: fx.ap, bank: fx.bank } }),
  )
  return id
}

/** Real application context with the actor's live resolved scope — never hand-built. */
async function appContext(fx: ReplayFixture, userId: string) {
  const scope = await withBypass(() => actorAllowedSubsidiaryIds(db, fx.orgId, userId))
  return {
    authz: {
      user: {
        id: userId,
        email: 'sv-app-scope@scratch.test',
        name: 'SV App Scope',
        roles: [{ key: 'sv_app_root', name: 'SV App Root' }],
        orgId: fx.orgId,
        envKind: 'production' as const,
        productionOrgId: fx.orgId,
        isSuperAdmin: false,
        homeUserId: userId,
        homeOrgId: fx.orgId,
      },
      permissions: new Set(['stored_value.read', 'stored_value.manage']),
      allowedSubsidiaryIds: scope,
    },
    source: 'api' as const,
    requestId: randomUUID(),
    apiKeyId: null,
  }
}

test('a different card under the same key redeems fresh instead of replaying', { skip: !DB }, async () => {
  const fx = await seedReplayOrg()
  try {
    const inv1 = await postRootInvoice(fx, '100')
    const inv2 = await postRootInvoice(fx, '100')
    const key = `app-replay-${randomUUID()}`
    const ctx = await appContext(fx, fx.rootActor)
    const first = await redeemStoredValueForInvoice(ctx, { code: fx.codeA, invoiceId: inv1, amount: '100', idempotencyKey: key })
    assert.equal(first.replayed, false)
    assert.equal(first.result.accountId, fx.accountA, 'first receipt names the first card')
    // Same key, same amount, different secret code: the hashed identity
    // differs, so this must redeem the second card — never replay the first.
    const second = await redeemStoredValueForInvoice(ctx, { code: fx.codeB, invoiceId: inv2, amount: '100', idempotencyKey: key })
    assert.equal(second.replayed, false, 'a different code hashes differently and must not replay')
    assert.equal(second.result.accountId, fx.accountB, 'second receipt names the second card')
    assert.notEqual(second.result.entryId, first.result.entryId, 'two redemptions post two entries')
  } finally {
    await withBypass(() => dropScratchOrg(fx.orgId))
  }
})

test('losing visibility denies the same-key replay without returning the receipt', { skip: !DB }, async () => {
  const fx = await seedReplayOrg()
  try {
    const inv = await postRootInvoice(fx, '100')
    const key = `app-loss-${randomUUID()}`
    const ctx = await appContext(fx, fx.rootActor)
    const first = await redeemStoredValueForInvoice(ctx, { code: fx.codeA, invoiceId: inv, amount: '100', idempotencyKey: key })
    assert.equal(first.result.accountId, fx.accountA)
    // The actor's grant narrows to the other entity after redemption.
    await withBypass(() =>
      db.execute(sql`
        update app_roles set subsidiary_restriction = ${JSON.stringify({ mode: 'list', subsidiaryIds: [fx.secondId] })}::jsonb
         where org_id = ${fx.orgId} and key = 'sv_app_root'`),
    )
    const narrowed = await appContext(fx, fx.rootActor)
    assert.ok(narrowed.authz.allowedSubsidiaryIds && !narrowed.authz.allowedSubsidiaryIds.has(fx.subsidiaryId))
    const error = await redeemStoredValueForInvoice(narrowed, { code: fx.codeA, invoiceId: inv, amount: '100', idempotencyKey: key }).then(
      () => null,
      (error: unknown) => error,
    )
    assert.ok(error instanceof ApplicationError, 'the replay refuses once visibility is lost')
    assert.equal(error.status, 404, 'denied replay reads as missing')
    assert.ok(!JSON.stringify(error).includes(fx.accountA), 'no hidden account id rides the denial')
  } finally {
    await withBypass(() => dropScratchOrg(fx.orgId))
  }
})

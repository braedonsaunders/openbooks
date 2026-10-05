import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass, withOrgTransaction } from "../platform/db.ts";
import { withSimClock } from "../platform/clock.ts";
import { toUnits } from "../money/money.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { createProgram, issueStoredValue, redeemStoredValue } from "./accounts.ts";
import { runStoredValueBreakage } from "./breakage.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  seedPostingAccount,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

type Org = Awaited<ReturnType<typeof createScratchOrg>>;

interface StoredValueFixture {
  org: Org;
  actorId: string;
  liability: string;
  breakageIncome: string;
  giftProgram: string;
  creditProgram: string;
  giftItem: string;
}

async function seedStoredValueOrg(): Promise<StoredValueFixture> {
  const org = await createScratchOrg();
  const actorId = await withBypass(() => createScratchUser(org.orgId, "SV Tester", "admin"));
  const liability = await withBypass(() =>
    seedPostingAccount(org.orgId, "2600", "Gift card liability", "liability_current_other"),
  );
  const breakageIncome = await withBypass(() =>
    seedPostingAccount(org.orgId, "4900", "Breakage income", "income_other"),
  );
  await withBypass(async () => {
    await db.execute(sql`
      update orgs set settings = settings
        || jsonb_build_object('features', coalesce(settings->'features', '{}'::jsonb) || '{"storedValue": true}'::jsonb)
       where id = ${org.orgId}`);
    await db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{controlAccounts,storedValueLiability}', to_jsonb(${liability}::text), true)
       where id = ${org.orgId}`);
    // The scan posts on the business day; keep a period open under it.
    await db.execute(sql`
      insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
      select ${randomUUID()}, ${org.orgId}, 2026, 10, '2026-10', '2026-10-01', '2026-10-31', false, fiscal_calendar_id
        from accounting_periods where id = ${org.periodId}`);
  });
  const giftProgram = await withBypass(() =>
    createProgram({
      orgId: org.orgId,
      name: "Holiday gift cards",
      kind: "gift_card",
      liabilityAccountId: liability,
      breakageIncomeAccountId: breakageIncome,
      breakagePolicy: "proportional",
      breakageRate: "0.10",
      actorId,
    }),
  );
  const creditProgram = await withBypass(() =>
    createProgram({
      orgId: org.orgId,
      name: "Store credit",
      kind: "store_credit",
      liabilityAccountId: liability,
      breakageIncomeAccountId: breakageIncome,
      breakagePolicy: "remote",
      inactivityMonths: 1,
      actorId,
    }),
  );
  const giftItem = randomUUID();
  await withBypass(async () => {
    await db.execute(sql`
      insert into items (id, org_id, kind, code, name, income_account_id, created_by, updated_by)
      values (${giftItem}, ${org.orgId}, 'gift_card', 'GIFTCARD', 'Gift card', ${org.accounts.revenue}, ${actorId}, ${actorId})`);
  });
  return { org, actorId, liability, breakageIncome, giftProgram: giftProgram.id, creditProgram: creditProgram.id, giftItem };
}

async function entryBalanced(orgId: string, entryId: string): Promise<boolean> {
  const rows = (await withBypass(() => db.execute<{ balanced: boolean }>(sql`
    select coalesce(sum(amount), 0) = 0 as balanced from journal_lines
     where org_id = ${orgId} and entry_id = ${entryId}`))).rows;
  return rows[0]?.balanced ?? false;
}

async function accountState(orgId: string, accountId: string) {
  return (await withBypass(() => db.execute<{
    balance: string; issued: string; recognized: string; status: string; entries: number; journalId: string | null;
  }>(sql`
    select a.balance_minor::text as balance, a.issued_minor::text as issued,
           a.breakage_recognized_minor::text as recognized, a.status,
           (select count(*)::int from stored_value_entries where org_id = ${orgId} and account_id = ${accountId}) as entries,
           (select journal_entry_id from stored_value_entries where org_id = ${orgId} and account_id = ${accountId} and kind = 'issue') as "journalId"
      from stored_value_accounts a where a.org_id = ${orgId} and a.id = ${accountId}`))).rows[0]!;
}

test("a gift card sale posts the liability, never revenue, and mints a redeemable account", { skip: !DB }, async () => {
  const fx = await seedStoredValueOrg();
  const { org, actorId } = fx;
  try {
    const invoiceId = randomUUID();
    await withBypass(async () => {
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, document_number, party_id, subsidiary_id,
           document_date, currency, fx_rate, status, subtotal, tax_total, total,
           created_by, updated_by)
        values (${invoiceId}, ${org.orgId}, 'customer_invoice', 'INV-SV-1', ${org.customerId},
          ${org.subsidiaryId}, ${org.date}, 'CAD', '1', 'draft', '50', '0', '50', ${actorId}, ${actorId})`);
      await db.execute(sql`
        insert into document_lines
          (org_id, document_id, line_number, item_id, account_id, quantity, unit_price, amount,
           tax_input_amount, tax_amount, custom, created_by, updated_by)
        values (${org.orgId}, ${invoiceId}, 1, ${fx.giftItem}, ${org.accounts.revenue}, '1', '50', '50',
          '50', '0', ${JSON.stringify({ storedValueProgramId: fx.giftProgram })}::jsonb, ${actorId}, ${actorId})`);
      await db.execute(sql`
        update documents set status = 'approved' where id = ${invoiceId} and org_id = ${org.orgId}`);
    });
    const entryId = await withBypass(() =>
      postDocument(invoiceId, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } }),
    );
    const legs = (await withBypass(() => db.execute<{ account: string; amount: string }>(sql`
      select account_id as account, amount::text as amount from journal_lines
       where org_id = ${org.orgId} and entry_id = ${entryId} order by account_id`))).rows;
    const byAccount = new Map(legs.map((leg) => [leg.account, leg.amount]));
    assert.equal(byAccount.get(fx.liability), "-50.0000");
    assert.ok(!byAccount.has(org.accounts.revenue), "gift card sale must not touch revenue");
    assert.equal(await entryBalanced(org.orgId, entryId), true);
    const accounts = (await withBypass(() => db.execute<{ id: string }>(sql`
      select id from stored_value_accounts where org_id = ${org.orgId} and source_document_id = ${invoiceId}`))).rows;
    assert.equal(accounts.length, 1);
    const state = await accountState(org.orgId, accounts[0]!.id);
    assert.equal(state.balance, "500000");
    assert.equal(state.issued, "500000");
    assert.equal(state.status, "active");
    assert.equal(state.entries, 1);
    assert.equal(state.journalId, entryId);
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("two concurrent redemptions cannot overdraw: one wins, the other is refused with the balance", { skip: !DB }, async () => {
  const fx = await seedStoredValueOrg();
  const { org, actorId } = fx;
  try {
    const issued = await withBypass(() =>
      issueStoredValue({
        orgId: org.orgId,
        programId: fx.giftProgram,
        amountMinor: toUnits("100"),
        currency: "CAD",
        debitAccountId: org.accounts.bank,
        postingDate: org.date,
        idempotencyKey: `race-${randomUUID()}`,
        actorId,
      }),
    );
    const attempt = (key: string) =>
      withOrgTransaction(org.orgId, () =>
        redeemStoredValue({
          orgId: org.orgId,
          accountId: issued.accountId,
          amountMinor: toUnits("60"),
          idempotencyKey: key,
          actorId,
        }),
      );
    const [first, second] = await Promise.allSettled([attempt(`race-a-${randomUUID()}`), attempt(`race-b-${randomUUID()}`)]);
    const fulfilled = [first, second].filter((r) => r.status === "fulfilled");
    const rejected = [first, second].filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    const reason = String((rejected[0] as PromiseRejectedResult).reason?.message ?? (rejected[0] as PromiseRejectedResult).reason);
    assert.match(reason, /holds 40\.0000/);
    const state = await accountState(org.orgId, issued.accountId);
    assert.equal(state.balance, "400000");
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("proportional breakage recognizes redemptions times r/(1-r) in minor units", { skip: !DB }, async () => {
  const fx = await seedStoredValueOrg();
  const { org, actorId } = fx;
  try {
    const issued = await withBypass(() =>
      issueStoredValue({
        orgId: org.orgId,
        programId: fx.giftProgram,
        amountMinor: toUnits("100"),
        currency: "CAD",
        debitAccountId: org.accounts.bank,
        postingDate: org.date,
        idempotencyKey: `brk-${randomUUID()}`,
        actorId,
      }),
    );
    await withBypass(() =>
      redeemStoredValue({
        orgId: org.orgId,
        accountId: issued.accountId,
        amountMinor: toUnits("90"),
        idempotencyKey: `brk-redeem-${randomUUID()}`,
        actorId,
      }),
    );
    const result = await runStoredValueBreakage();
    assert.deepEqual(result.orgErrors, []);
    assert.equal(result.recognizedAccounts, 1);
    const state = await accountState(org.orgId, issued.accountId);
    assert.equal(state.balance, "0");
    assert.equal(state.recognized, "100000");
    const entry = (await withBypass(() => db.execute<{ kind: string; amount: string; journal: string }>(sql`
      select kind, amount_minor::text as amount, journal_entry_id as journal
        from stored_value_entries
       where org_id = ${org.orgId} and account_id = ${issued.accountId} and kind = 'breakage'`))).rows;
    assert.equal(entry.length, 1);
    assert.equal(entry[0]!.amount, "-100000");
    const legs = (await withBypass(() => db.execute<{ account: string; amount: string }>(sql`
      select account_id as account, amount::text as amount from journal_lines
       where org_id = ${org.orgId} and entry_id = ${entry[0]!.journal}`))).rows;
    const byAccount = new Map(legs.map((leg) => [leg.account, leg.amount]));
    assert.equal(byAccount.get(fx.liability), "10.0000");
    assert.equal(byAccount.get(fx.breakageIncome), "-10.0000");
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("a second scan in one period and a replayed redemption each move the balance at most once", { skip: !DB }, async () => {
  const fx = await seedStoredValueOrg();
  const { org, actorId } = fx;
  try {
    await withSimClock("2026-10-15T12:00:00Z", async () => {
      const issued = await withBypass(() =>
        issueStoredValue({
          orgId: org.orgId,
          programId: fx.giftProgram,
          amountMinor: toUnits("100"),
          currency: "CAD",
          debitAccountId: org.accounts.bank,
          postingDate: org.date,
          idempotencyKey: `twice-${randomUUID()}`,
          actorId,
        }),
      );
      const redeem = (amount: string, key: string) =>
        withBypass(() =>
          redeemStoredValue({ orgId: org.orgId, accountId: issued.accountId, amountMinor: toUnits(amount), idempotencyKey: key, actorId }),
        );
      const scan = async () =>
        (await runStoredValueBreakage()).orgErrors.filter((failure) => failure.orgId === org.orgId);
      await redeem("45", `twice-a-${randomUUID()}`);
      assert.deepEqual(await scan(), []);
      const first = await accountState(org.orgId, issued.accountId);
      assert.equal(first.balance, "500000");
      assert.equal(first.recognized, "50000");
      // A retried redemption returns the first result and moves nothing.
      const key = `twice-b-${randomUUID()}`;
      await redeem("18", key);
      assert.equal((await redeem("18", key)).balanceMinor, toUnits("32"));
      // The new redemption makes breakage due again, but this period's
      // recognition is already recorded: the second scan moves nothing.
      assert.deepEqual(await scan(), []);
      const after = await accountState(org.orgId, issued.accountId);
      assert.equal(after.balance, "320000");
      assert.equal(after.recognized, "50000");
      const counts = (await withBypass(() => db.execute<{ journals: number; breakage: number }>(sql`
        select (select count(*)::int from journal_entries
                 where org_id = ${org.orgId} and custom->>'idempotencyKey' like ${`stored-value:breakage:${issued.accountId}:%`}) as journals,
               (select count(*)::int from stored_value_entries
                 where org_id = ${org.orgId} and account_id = ${issued.accountId} and kind = 'breakage') as breakage`))).rows[0]!;
      assert.deepEqual(counts, { journals: 1, breakage: 1 });
    });
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("a card redeems through its expiry date and the scan sweeps it the day after", { skip: !DB }, async () => {
  const fx = await seedStoredValueOrg();
  const { org, actorId } = fx;
  try {
    const issued = await withBypass(() =>
      issueStoredValue({
        orgId: org.orgId,
        programId: fx.giftProgram,
        amountMinor: toUnits("30"),
        currency: "CAD",
        expiresOn: "2026-10-15",
        debitAccountId: org.accounts.bank,
        postingDate: org.date,
        idempotencyKey: `lastday-${randomUUID()}`,
        actorId,
      }),
    );
    const redeem = () =>
      withBypass(() =>
        redeemStoredValue({ orgId: org.orgId, accountId: issued.accountId, amountMinor: toUnits("10"), idempotencyKey: `lastday-${randomUUID()}`, actorId }),
      );
    await withSimClock("2026-10-15T12:00:00Z", async () => {
      await runStoredValueBreakage();
      assert.equal((await accountState(org.orgId, issued.accountId)).status, "active");
      assert.equal((await redeem()).balanceMinor, toUnits("20"));
    });
    await withSimClock("2026-10-16T12:00:00Z", async () => {
      await runStoredValueBreakage();
      const swept = await accountState(org.orgId, issued.accountId);
      assert.equal(swept.status, "expired");
      assert.equal(swept.balance, "0");
      await assert.rejects(redeem(), /expired/);
    });
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("the scan expires lapsed cards and releases dormant remote balances", { skip: !DB }, async () => {
  const fx = await seedStoredValueOrg();
  const { org, actorId } = fx;
  try {
    const expiring = await withBypass(() =>
      issueStoredValue({
        orgId: org.orgId,
        programId: fx.giftProgram,
        amountMinor: toUnits("30"),
        currency: "CAD",
        expiresOn: "2026-01-01",
        debitAccountId: org.accounts.bank,
        postingDate: org.date,
        idempotencyKey: `exp-${randomUUID()}`,
        actorId,
      }),
    );
    const dormant = await withBypass(() =>
      issueStoredValue({
        orgId: org.orgId,
        programId: fx.creditProgram,
        amountMinor: toUnits("25"),
        currency: "CAD",
        customerPartyId: org.customerId,
        debitAccountId: org.accounts.bank,
        postingDate: org.date,
        idempotencyKey: `dor-${randomUUID()}`,
        actorId,
      }),
    );
    await withBypass(async () => {
      await db.execute(sql`
        update stored_value_accounts set last_activity_on = '2026-01-01'
         where org_id = ${org.orgId} and id = ${dormant.accountId}`);
    });
    const result = await runStoredValueBreakage();
    assert.deepEqual(result.orgErrors, []);
    assert.equal(result.recognizedAccounts, 2);
    const expiredState = await accountState(org.orgId, expiring.accountId);
    assert.equal(expiredState.status, "expired");
    assert.equal(expiredState.balance, "0");
    const dormantState = await accountState(org.orgId, dormant.accountId);
    assert.equal(dormantState.status, "closed");
    assert.equal(dormantState.balance, "0");
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("stored-value entries are immutable", { skip: !DB }, async () => {
  const fx = await seedStoredValueOrg();
  const { org, actorId } = fx;
  try {
    const issued = await withBypass(() =>
      issueStoredValue({
        orgId: org.orgId,
        programId: fx.giftProgram,
        amountMinor: toUnits("10"),
        currency: "CAD",
        debitAccountId: org.accounts.bank,
        postingDate: org.date,
        idempotencyKey: `imm-${randomUUID()}`,
        actorId,
      }),
    );
    const immutable = (error: unknown) => {
      const message = `${(error as { cause?: { message?: string } })?.cause?.message ?? ""} ${(error as Error)?.message ?? ""}`;
      return /immutable/.test(message);
    };
    await assert.rejects(
      withBypass(() => db.execute(sql`
        update stored_value_entries set reason = 'rewritten'
         where org_id = ${org.orgId} and account_id = ${issued.accountId}`)),
      immutable,
    );
    await assert.rejects(
      withBypass(() => db.execute(sql`
        delete from stored_value_entries
         where org_id = ${org.orgId} and account_id = ${issued.accountId}`)),
      immutable,
    );
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("one org cannot read or redeem another org's stored value", { skip: !DB }, async () => {
  const first = await withBypass(() => seedStoredValueOrg());
  const second = await withBypass(() => seedStoredValueOrg());
  try {
    const issued = await withBypass(() =>
      issueStoredValue({
        orgId: first.org.orgId,
        programId: first.giftProgram,
        amountMinor: toUnits("10"),
        currency: "CAD",
        debitAccountId: first.org.accounts.bank,
        postingDate: first.org.date,
        idempotencyKey: `rls-${randomUUID()}`,
        actorId: first.actorId,
      }),
    );
    const visible = await withOrgTransaction(second.org.orgId, async () => {
      const rows = (await db.execute<{ id: string }>(sql`
        select id from stored_value_accounts where org_id = ${first.org.orgId}`)).rows;
      return rows;
    });
    assert.deepEqual(visible, []);
    // From the wrong scope the owning org itself is invisible, so the
    // feature gate fails closed before any account is named.
    await assert.rejects(
      withOrgTransaction(second.org.orgId, () =>
        redeemStoredValue({
          orgId: first.org.orgId,
          accountId: issued.accountId,
          amountMinor: toUnits("1"),
          idempotencyKey: `rls-redeem-${randomUUID()}`,
          actorId: second.actorId,
        }),
      ),
      /Stored value is disabled/,
    );
    // A write that matches zero rows is a failure: an unknown account in
    // the caller's own scope refuses by name.
    await assert.rejects(
      withBypass(() =>
        redeemStoredValue({
          orgId: first.org.orgId,
          accountId: randomUUID(),
          amountMinor: toUnits("1"),
          idempotencyKey: `rls-missing-${randomUUID()}`,
          actorId: first.actorId,
        }),
      ),
      /does not exist in this organization/,
    );
  } finally {
    await withBypass(() => dropScratchOrg(first.org.orgId));
    await withBypass(() => dropScratchOrg(second.org.orgId));
  }
});

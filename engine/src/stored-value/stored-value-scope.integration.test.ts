import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass } from "../platform/db.ts";
import { toUnits } from "../money/money.ts";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import {
  adjustStoredValue,
  createProgram,
  expireStoredValueAccount,
  issueStoredValue,
  lookupStoredValueByCode,
  redeemStoredValue,
  resolveStoredValueTender,
  setStoredValueStatus,
} from "./accounts.ts";
import { StoredValueError } from "./errors.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  seedPostingAccount,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

interface ScopeFixture {
  orgId: string;
  subsidiaryId: string;
  secondId: string;
  date: string;
  bank: string;
  actorId: string;
  giftProgram: string;
  expiringProgram: string;
  rootActor: string;
  multiActor: string;
}

async function seedScopeOrg(): Promise<ScopeFixture> {
  const org = await createScratchOrg();
  const actorId = await withBypass(() => createScratchUser(org.orgId, "SV Scope", "sv_scope"));
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
    await db.execute(sql`
      insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
      select ${randomUUID()}, ${org.orgId}, 2026, 10, '2026-10', '2026-10-01', '2026-10-31', false, fiscal_calendar_id
        from accounting_periods where id = ${org.periodId}`);
  });
  const secondId = (await withBypass(() => db.execute<{ id: string }>(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    select ${randomUUID()}, ${org.orgId}, s.id, 'Second Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb
      from subsidiaries s where s.org_id = ${org.orgId} and s.parent_id is null limit 1 returning id`))).rows[0]!.id;
  const giftProgram = await withBypass(() =>
    createProgram({
      orgId: org.orgId,
      name: "Scope gift cards",
      kind: "gift_card",
      liabilityAccountId: liability,
      breakageIncomeAccountId: breakageIncome,
      breakagePolicy: "none",
      actorId,
    }),
  );
  const expiringProgram = await withBypass(() =>
    createProgram({
      orgId: org.orgId,
      name: "Scope expiring cards",
      kind: "gift_card",
      liabilityAccountId: liability,
      breakageIncomeAccountId: breakageIncome,
      breakagePolicy: "none",
      expiryMonths: 1,
      actorId,
    }),
  );
  async function scopedActor(name: string, key: string, subsidiaryIds: string[]): Promise<string> {
    const user = await withBypass(() => createScratchUser(org.orgId, name, key));
    await withBypass(async () => {
      const updated = await db.execute(sql`
        update app_roles set permissions = '["stored_value.read","stored_value.manage","stored_value.adjust"]'::jsonb,
          subsidiary_restriction = ${JSON.stringify({ mode: "list", subsidiaryIds })}::jsonb
         where org_id = ${org.orgId} and key = ${key} returning id`);
      assert.equal(updated.rows.length, 1, `${key}: scoped actor setup updates one role`);
    });
    return user;
  }
  const rootActor = await scopedActor("SV Root", "sv_root", [org.subsidiaryId]);
  const multiActor = await scopedActor("SV Multi", "sv_multi", [org.subsidiaryId, secondId]);
  return {
    orgId: org.orgId,
    subsidiaryId: org.subsidiaryId,
    secondId,
    date: org.date,
    bank: org.accounts.bank,
    actorId,
    giftProgram: giftProgram.id,
    expiringProgram: expiringProgram.id,
    rootActor,
    multiActor,
  };
}

/** The actor's live scope, resolved through the canonical contract — never hand-built. */
async function liveScope(orgId: string, userId: string): Promise<Set<string> | null> {
  return withBypass(() => actorAllowedSubsidiaryIds(db, orgId, userId));
}

/** Mint one account in the named entity as the system (explicit null sentinel). */
async function mintIn(fx: ScopeFixture, subsidiaryId: string, amount = "100"): Promise<{ accountId: string; code: string }> {
  const issued = await withBypass(() =>
    issueStoredValue({
      orgId: fx.orgId,
      allowedSubsidiaryIds: null,
      subsidiaryId,
      programId: fx.giftProgram,
      amountMinor: toUnits(amount),
      currency: "CAD",
      debitAccountId: fx.bank,
      postingDate: fx.date,
      idempotencyKey: `scope-${randomUUID()}`,
      actorId: fx.actorId,
    }),
  );
  assert.ok(issued.code, "first issuance shows the code once");
  return { accountId: issued.accountId, code: issued.code! };
}

async function balanceOf(orgId: string, accountId: string): Promise<{ balance: string; status: string; entries: number }> {
  return (await withBypass(() => db.execute<{ balance: string; status: string; entries: number }>(sql`
    select a.balance_minor::text as balance, a.status,
      (select count(*)::int from stored_value_entries where org_id = ${orgId} and account_id = ${accountId}) as entries
      from stored_value_accounts a where a.org_id = ${orgId} and a.id = ${accountId}`))).rows[0]!;
}

test("a restricted actor's adjustment of a foreign-entity account reads as missing and writes nothing", { skip: !DB }, async () => {
  const fx = await seedScopeOrg();
  try {
    const foreign = await mintIn(fx, fx.secondId);
    const before = await balanceOf(fx.orgId, foreign.accountId);
    const scope = await liveScope(fx.orgId, fx.rootActor);
    assert.ok(scope !== null && scope.has(fx.subsidiaryId) && !scope.has(fx.secondId));
    await assert.rejects(
      withBypass(() =>
        adjustStoredValue({
          orgId: fx.orgId,
          accountId: foreign.accountId,
          allowedSubsidiaryIds: scope,
          deltaMinor: toUnits("5"),
          reason: "Counting error on issue",
          offsetAccountId: fx.bank,
          postingDate: fx.date,
          idempotencyKey: `scope-adjust-${randomUUID()}`,
          actorId: fx.rootActor,
        }),
      ),
      (error: unknown) => error instanceof ScopeNotFoundError,
      "a hidden balance must refuse as missing, never as a named adjustment error",
    );
    assert.deepEqual(await balanceOf(fx.orgId, foreign.accountId), before, "the refused adjustment writes nothing");
  } finally {
    await withBypass(() => dropScratchOrg(fx.orgId));
  }
});

test("a restricted actor's status change of a foreign-entity account reads as missing before any lifecycle refusal", { skip: !DB }, async () => {
  const fx = await seedScopeOrg();
  try {
    const foreign = await mintIn(fx, fx.secondId);
    const scope = await liveScope(fx.orgId, fx.rootActor);
    // Closing a nonzero card would otherwise refuse close_nonzero by name —
    // the scope denial must come first so the balance never leaks.
    await assert.rejects(
      withBypass(() =>
        setStoredValueStatus({
          orgId: fx.orgId,
          accountId: foreign.accountId,
          allowedSubsidiaryIds: scope,
          to: "closed",
          actorId: fx.rootActor,
        }),
      ),
      (error: unknown) => error instanceof ScopeNotFoundError,
    );
    assert.equal((await balanceOf(fx.orgId, foreign.accountId)).status, "active");
  } finally {
    await withBypass(() => dropScratchOrg(fx.orgId));
  }
});

test("a restricted actor's redemption of a foreign-entity account reads as missing and moves nothing", { skip: !DB }, async () => {
  const fx = await seedScopeOrg();
  try {
    const foreign = await mintIn(fx, fx.secondId);
    const before = await balanceOf(fx.orgId, foreign.accountId);
    const scope = await liveScope(fx.orgId, fx.rootActor);
    await assert.rejects(
      withBypass(() =>
        redeemStoredValue({
          orgId: fx.orgId,
          accountId: foreign.accountId,
          allowedSubsidiaryIds: scope,
          amountMinor: toUnits("10"),
          idempotencyKey: `scope-redeem-${randomUUID()}`,
          actorId: fx.rootActor,
        }),
      ),
      (error: unknown) => error instanceof ScopeNotFoundError,
    );
    assert.deepEqual(await balanceOf(fx.orgId, foreign.accountId), before);
  } finally {
    await withBypass(() => dropScratchOrg(fx.orgId));
  }
});

test("code lookups hide foreign-entity accounts and fail closed on unknown scope", { skip: !DB }, async () => {
  const fx = await seedScopeOrg();
  try {
    const foreign = await mintIn(fx, fx.secondId);
    const scope = await liveScope(fx.orgId, fx.rootActor);
    assert.equal(
      await withBypass(() => lookupStoredValueByCode(fx.orgId, foreign.code, scope)),
      null,
      "a foreign-entity code reads exactly like a wrong code",
    );
    assert.equal(
      await withBypass(() => resolveStoredValueTender(fx.orgId, foreign.code, scope)),
      null,
      "tender resolution hides the foreign account too",
    );
    assert.equal(
      await withBypass(() => lookupStoredValueByCode(fx.orgId, foreign.code, undefined as unknown as null)),
      null,
      "unknown scope never becomes unrestricted",
    );
    const seen = await withBypass(() => lookupStoredValueByCode(fx.orgId, foreign.code, null));
    assert.equal(seen?.accountId, foreign.accountId, "the explicit system sentinel still resolves");
  } finally {
    await withBypass(() => dropScratchOrg(fx.orgId));
  }
});

test("a single-entity actor issues into their entity by default, and is refused by name outside it", { skip: !DB }, async () => {
  const fx = await seedScopeOrg();
  try {
    const scope = await liveScope(fx.orgId, fx.rootActor);
    const issued = await withBypass(() =>
      issueStoredValue({
        orgId: fx.orgId,
        allowedSubsidiaryIds: scope,
        programId: fx.giftProgram,
        amountMinor: toUnits("25"),
        currency: "CAD",
        debitAccountId: fx.bank,
        postingDate: fx.date,
        idempotencyKey: `scope-issue-${randomUUID()}`,
        actorId: fx.rootActor,
      }),
    );
    const home = (await withBypass(() => db.execute<{ subsidiary: string }>(sql`
      select subsidiary_id as subsidiary from stored_value_accounts where org_id = ${fx.orgId} and id = ${issued.accountId}`))).rows[0]!;
    assert.equal(home.subsidiary, fx.subsidiaryId, "the issue lands in the actor's single allowed entity");
    await assert.rejects(
      withBypass(() =>
        issueStoredValue({
          orgId: fx.orgId,
          allowedSubsidiaryIds: scope,
          subsidiaryId: fx.secondId,
          programId: fx.giftProgram,
          amountMinor: toUnits("25"),
          currency: "CAD",
          debitAccountId: fx.bank,
          postingDate: fx.date,
          idempotencyKey: `scope-issue-${randomUUID()}`,
          actorId: fx.rootActor,
        }),
      ),
      (error: unknown) => error instanceof StoredValueError && error.code === "stored_value_subsidiary_out_of_scope",
      "a foreign entity is refused by name with the visible-entity remedy",
    );
  } finally {
    await withBypass(() => dropScratchOrg(fx.orgId));
  }
});

test("a multi-entity actor naming no entity is asked to choose, and unknown scope never issues", { skip: !DB }, async () => {
  const fx = await seedScopeOrg();
  try {
    const scope = await liveScope(fx.orgId, fx.multiActor);
    assert.equal(scope?.size, 2);
    await assert.rejects(
      withBypass(() =>
        issueStoredValue({
          orgId: fx.orgId,
          allowedSubsidiaryIds: scope,
          programId: fx.giftProgram,
          amountMinor: toUnits("25"),
          currency: "CAD",
          debitAccountId: fx.bank,
          postingDate: fx.date,
          idempotencyKey: `scope-issue-${randomUUID()}`,
          actorId: fx.multiActor,
        }),
      ),
      (error: unknown) => error instanceof StoredValueError && error.code === "stored_value_subsidiary_required",
      "no silent root default for a caller who must choose",
    );
    await assert.rejects(
      withBypass(() =>
        issueStoredValue({
          orgId: fx.orgId,
          allowedSubsidiaryIds: undefined as unknown as null,
          subsidiaryId: fx.subsidiaryId,
          programId: fx.giftProgram,
          amountMinor: toUnits("25"),
          currency: "CAD",
          debitAccountId: fx.bank,
          postingDate: fx.date,
          idempotencyKey: `scope-issue-${randomUUID()}`,
          actorId: fx.multiActor,
        }),
      ),
      (error: unknown) => error instanceof ScopeNotFoundError,
      "unknown scope fails closed instead of issuing",
    );
  } finally {
    await withBypass(() => dropScratchOrg(fx.orgId));
  }
});

test("the permitted same-entity path still adjusts, freezes, and redeems", { skip: !DB }, async () => {
  const fx = await seedScopeOrg();
  try {
    const own = await mintIn(fx, fx.subsidiaryId, "50");
    const scope = await liveScope(fx.orgId, fx.rootActor);
    const seen = await withBypass(() => lookupStoredValueByCode(fx.orgId, own.code, scope));
    assert.equal(seen?.accountId, own.accountId, "the own-entity code resolves");
    await withBypass(() =>
      adjustStoredValue({
        orgId: fx.orgId,
        accountId: own.accountId,
        allowedSubsidiaryIds: scope,
        deltaMinor: toUnits("5"),
        reason: "Counting error on issue",
        offsetAccountId: fx.bank,
        postingDate: fx.date,
        idempotencyKey: `scope-own-${randomUUID()}`,
        actorId: fx.rootActor,
      }),
    );
    await withBypass(() =>
      setStoredValueStatus({
        orgId: fx.orgId,
        accountId: own.accountId,
        allowedSubsidiaryIds: scope,
        to: "frozen",
        actorId: fx.rootActor,
      }),
    );
    assert.equal((await balanceOf(fx.orgId, own.accountId)).status, "frozen");
    await withBypass(() =>
      setStoredValueStatus({
        orgId: fx.orgId,
        accountId: own.accountId,
        allowedSubsidiaryIds: scope,
        to: "active",
        actorId: fx.rootActor,
      }),
    );
    const redeemed = await withBypass(() =>
      redeemStoredValue({
        orgId: fx.orgId,
        accountId: own.accountId,
        allowedSubsidiaryIds: scope,
        amountMinor: toUnits("10"),
        idempotencyKey: `scope-own-${randomUUID()}`,
        actorId: fx.rootActor,
      }),
    );
    assert.equal(redeemed.balanceMinor, toUnits("45"));
  } finally {
    await withBypass(() => dropScratchOrg(fx.orgId));
  }
});

test("the scan's expiry of a foreign-entity account reads as missing under a restricted scope", { skip: !DB }, async () => {
  const fx = await seedScopeOrg();
  try {
    const issued = await withBypass(() =>
      issueStoredValue({
        orgId: fx.orgId,
        allowedSubsidiaryIds: null,
        subsidiaryId: fx.secondId,
        programId: fx.expiringProgram,
        amountMinor: toUnits("20"),
        currency: "CAD",
        debitAccountId: fx.bank,
        postingDate: fx.date,
        idempotencyKey: `scope-exp-${randomUUID()}`,
        actorId: fx.actorId,
      }),
    );
    const scope = await liveScope(fx.orgId, fx.rootActor);
    await assert.rejects(
      withBypass(() =>
        expireStoredValueAccount({
          orgId: fx.orgId,
          accountId: issued.accountId,
          allowedSubsidiaryIds: scope,
          postingDate: fx.date,
          idempotencyKey: `scope-exp-${randomUUID()}`,
        }),
      ),
      (error: unknown) => error instanceof ScopeNotFoundError,
    );
    assert.equal((await balanceOf(fx.orgId, issued.accountId)).status, "active");
  } finally {
    await withBypass(() => dropScratchOrg(fx.orgId));
  }
});

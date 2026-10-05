import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass, withOrgContext } from "../platform/db.ts";
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
  bank2: string;
  offset: string;
  actorId: string;
  giftProgram: string;
  expiringProgram: string;
  creditProgram: string;
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
  const bank2 = await withBypass(() =>
    seedPostingAccount(org.orgId, "1090", "Scope second bank", "asset_bank"),
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
  const creditProgram = await withBypass(() =>
    createProgram({
      orgId: org.orgId,
      name: "Scope store credit",
      kind: "store_credit",
      liabilityAccountId: liability,
      breakageIncomeAccountId: breakageIncome,
      breakagePolicy: "none",
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
    bank2,
    offset: org.accounts.cogs,
    actorId,
    giftProgram: giftProgram.id,
    expiringProgram: expiringProgram.id,
    creditProgram: creditProgram.id,
    rootActor,
    multiActor,
  };
}

/**
 * The actor's live scope through the canonical contract — never hand-built.
 * The grant read rides bypass exactly like the web grant reader
 * (allowedSubsidiaryIds): it resolves stored role grants, while every
 * operation under test below runs tenant-scoped.
 */
async function liveScope(orgId: string, userId: string): Promise<Set<string> | null> {
  return withBypass(() => actorAllowedSubsidiaryIds(db, orgId, userId));
}

/**
 * Mint one account in the named entity under tenant context with explicit
 * null — the unrestricted grant named outright. Seeding the fixture this
 * way exercises the same RLS path production system writes take.
 */
async function mintIn(
  fx: ScopeFixture,
  subsidiaryId: string,
  amount = "100",
  key = `scope-${randomUUID()}`,
  programId?: string,
): Promise<{ accountId: string; code: string }> {
  const issued = await withOrgContext(fx.orgId, () =>
    issueStoredValue({
      orgId: fx.orgId,
      allowedSubsidiaryIds: null,
      subsidiaryId,
      programId: programId ?? fx.giftProgram,
      amountMinor: toUnits(amount),
      currency: "CAD",
      debitAccountId: fx.bank,
      postingDate: fx.date,
      idempotencyKey: key,
      actorId: fx.actorId,
    }),
  );
  assert.ok(issued.code, "first issuance shows the code once");
  return { accountId: issued.accountId, code: issued.code! };
}

/** Seed one customer party in the named entity (null = shared org-wide party). */
async function seedParty(fx: ScopeFixture, name: string, subsidiaryId: string | null): Promise<string> {
  const id = randomUUID();
  await withBypass(() => db.execute(sql`
    insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
    values (${id}, ${fx.orgId}, 'customer', ${name}, ${subsidiaryId}, true, '{}'::jsonb)`));
  return id;
}

async function balanceOf(orgId: string, accountId: string): Promise<{ balance: string; status: string; entries: number }> {
  return (await withOrgContext(orgId, () => db.execute<{ balance: string; status: string; entries: number }>(sql`
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
      withOrgContext(fx.orgId, () =>
        adjustStoredValue({
          orgId: fx.orgId,
          accountId: foreign.accountId,
          allowedSubsidiaryIds: scope,
          deltaMinor: toUnits("5"),
          reason: "Counting error on issue",
          offsetAccountId: fx.offset,
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
      withOrgContext(fx.orgId, () =>
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
      withOrgContext(fx.orgId, () =>
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
      await withOrgContext(fx.orgId, () => lookupStoredValueByCode(fx.orgId, foreign.code, scope)),
      null,
      "a foreign-entity code reads exactly like a wrong code",
    );
    assert.equal(
      await withOrgContext(fx.orgId, () => resolveStoredValueTender(fx.orgId, foreign.code, scope)),
      null,
      "tender resolution hides the foreign account too",
    );
    assert.equal(
      await withOrgContext(fx.orgId, () => lookupStoredValueByCode(fx.orgId, foreign.code, undefined as unknown as null)),
      null,
      "unknown scope never becomes unrestricted",
    );
    const seen = await withOrgContext(fx.orgId, () => lookupStoredValueByCode(fx.orgId, foreign.code, null));
    assert.equal(seen?.accountId, foreign.accountId, "explicit null still resolves");
  } finally {
    await withBypass(() => dropScratchOrg(fx.orgId));
  }
});

test("a single-entity actor issues into their entity by default, and is refused by name outside it", { skip: !DB }, async () => {
  const fx = await seedScopeOrg();
  try {
    const scope = await liveScope(fx.orgId, fx.rootActor);
    const issued = await withOrgContext(fx.orgId, () =>
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
    const home = (await withOrgContext(fx.orgId, () => db.execute<{ subsidiary: string }>(sql`
      select subsidiary_id as subsidiary from stored_value_accounts where org_id = ${fx.orgId} and id = ${issued.accountId}`))).rows[0]!;
    assert.equal(home.subsidiary, fx.subsidiaryId, "the issue lands in the actor's single allowed entity");
    await assert.rejects(
      withOrgContext(fx.orgId, () =>
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
      withOrgContext(fx.orgId, () =>
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
      withOrgContext(fx.orgId, () =>
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
    const seen = await withOrgContext(fx.orgId, () => lookupStoredValueByCode(fx.orgId, own.code, scope));
    assert.equal(seen?.accountId, own.accountId, "the own-entity code resolves");
    await withOrgContext(fx.orgId, () =>
      adjustStoredValue({
        orgId: fx.orgId,
        accountId: own.accountId,
        allowedSubsidiaryIds: scope,
        deltaMinor: toUnits("5"),
        reason: "Counting error on issue",
        offsetAccountId: fx.offset,
        postingDate: fx.date,
        idempotencyKey: `scope-own-${randomUUID()}`,
        actorId: fx.rootActor,
      }),
    );
    await withOrgContext(fx.orgId, () =>
      setStoredValueStatus({
        orgId: fx.orgId,
        accountId: own.accountId,
        allowedSubsidiaryIds: scope,
        to: "frozen",
        actorId: fx.rootActor,
      }),
    );
    assert.equal((await balanceOf(fx.orgId, own.accountId)).status, "frozen");
    await withOrgContext(fx.orgId, () =>
      setStoredValueStatus({
        orgId: fx.orgId,
        accountId: own.accountId,
        allowedSubsidiaryIds: scope,
        to: "active",
        actorId: fx.rootActor,
      }),
    );
    const redeemed = await withOrgContext(fx.orgId, () =>
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
    const issued = await withOrgContext(fx.orgId, () =>
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
      withOrgContext(fx.orgId, () =>
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

test("absent and hidden accounts refuse identically, before any lifecycle message", { skip: !DB }, async () => {
  const fx = await seedScopeOrg();
  try {
    const foreign = await mintIn(fx, fx.secondId);
    const scope = await liveScope(fx.orgId, fx.rootActor);
    const attempt = (accountId: string) =>
      withOrgContext(fx.orgId, () =>
        adjustStoredValue({
          orgId: fx.orgId,
          accountId,
          allowedSubsidiaryIds: scope,
          deltaMinor: toUnits("5"),
          reason: "Counting error on issue",
          offsetAccountId: fx.offset,
          postingDate: fx.date,
          idempotencyKey: `scope-twin-${randomUUID()}`,
          actorId: fx.rootActor,
        }),
      ).then(
        () => null,
        (error: unknown) => error,
      );
    const hidden = await attempt(foreign.accountId);
    const missing = await attempt(randomUUID());
    assert.ok(hidden instanceof ScopeNotFoundError && missing instanceof ScopeNotFoundError);
    assert.equal(hidden.constructor, missing.constructor, "hidden and missing share one refusal shape");
    assert.equal(hidden.message, missing.message, "hidden and missing share one neutral message");
  } finally {
    await withBypass(() => dropScratchOrg(fx.orgId));
  }
});

test("a reused issuance key with a changed body is refused, while an unchanged retry replays after program deactivation", { skip: !DB }, async () => {
  const fx = await seedScopeOrg();
  try {
    const scope = await liveScope(fx.orgId, fx.rootActor);
    const key = `scope-replay-${randomUUID()}`;
    const first = await withOrgContext(fx.orgId, () =>
      issueStoredValue({
        orgId: fx.orgId,
        allowedSubsidiaryIds: scope,
        subsidiaryId: fx.subsidiaryId,
        programId: fx.giftProgram,
        amountMinor: toUnits("40"),
        currency: "CAD",
        debitAccountId: fx.bank,
        postingDate: fx.date,
        idempotencyKey: key,
        actorId: fx.rootActor,
      }),
    );
    assert.ok(first.code && !first.replayed);
    const retry = (over: {
      amountMinor?: bigint;
      programId?: string;
      debitAccountId?: string;
      expiresOn?: string | null;
      postingDate?: string;
      sourceDocumentId?: string | null;
      sourceLineId?: string | null;
    }) =>
      withOrgContext(fx.orgId, () =>
        issueStoredValue({
          orgId: fx.orgId,
          allowedSubsidiaryIds: scope,
          subsidiaryId: fx.subsidiaryId,
          programId: fx.giftProgram,
          amountMinor: toUnits("40"),
          currency: "CAD",
          debitAccountId: fx.bank,
          postingDate: fx.date,
          idempotencyKey: key,
          actorId: fx.rootActor,
          ...over,
        }),
      );
    const conflict = (error: unknown) =>
      error instanceof StoredValueError && error.code === "stored_value_idempotency_conflict";
    await assert.rejects(
      retry({ amountMinor: toUnits("41") }),
      conflict,
      "a changed amount reuses the key and must not receive the first receipt",
    );
    await assert.rejects(
      retry({ programId: fx.expiringProgram }),
      conflict,
      "a changed program reuses the key and must not receive the first receipt",
    );
    await assert.rejects(
      retry({ debitAccountId: fx.bank2 }),
      conflict,
      "a changed funding account reuses the key and must not receive the first receipt",
    );
    await assert.rejects(
      retry({ expiresOn: "2027-05-01" }),
      conflict,
      "a changed expiry reuses the key and must not receive the first receipt",
    );
    await assert.rejects(
      retry({ sourceDocumentId: randomUUID() }),
      conflict,
      "a changed source document reuses the key and must not receive the first receipt",
    );
    await assert.rejects(
      retry({ sourceLineId: randomUUID() }),
      conflict,
      "a changed source line reuses the key and must not receive the first receipt",
    );
    // A different calendar day in the same month: derived defaults never
    // collide with it, so only an explicit change trips the conflict.
    const otherDate = fx.date.endsWith("-02") ? `${fx.date.slice(0, -2)}03` : `${fx.date.slice(0, -2)}02`;
    await assert.rejects(
      retry({ postingDate: otherDate }),
      conflict,
      "a changed posting date reuses the key and must not receive the first receipt",
    );
    // Deactivating the program afterwards must not rewrite history: the
    // unchanged retry still replays the recorded effect.
    await withBypass(() => db.execute(sql`
      update stored_value_programs set is_active = false where id = ${fx.giftProgram} and org_id = ${fx.orgId}`));
    const replayed = await retry({});
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.code, null, "a replay never mints a second code");
    assert.equal(replayed.accountId, first.accountId);
  } finally {
    await withBypass(() => dropScratchOrg(fx.orgId));
  }
});

test("explicit expiry, date, and memo are evidenced in both directions", { skip: !DB }, async () => {
  const fx = await seedScopeOrg();
  try {
    const scope = await liveScope(fx.orgId, fx.rootActor);
    const key = `scope-stated-${randomUUID()}`;
    const body = {
      orgId: fx.orgId,
      allowedSubsidiaryIds: scope,
      subsidiaryId: fx.subsidiaryId,
      programId: fx.giftProgram,
      amountMinor: toUnits("23"),
      currency: "CAD",
      debitAccountId: fx.bank,
      postingDate: fx.date,
      expiresOn: "2027-05-01",
      memo: "Gift for Maya",
      idempotencyKey: key,
      actorId: fx.rootActor,
    };
    const first = await withOrgContext(fx.orgId, () => issueStoredValue(body));
    assert.ok(first.code && !first.replayed);
    const retry = (over: {
      expiresOn?: string | null;
      postingDate?: string;
      memo?: string | null;
    }) => {
      const { expiresOn, postingDate, memo, ...rest } = body;
      void expiresOn;
      void postingDate;
      void memo;
      return withOrgContext(fx.orgId, () =>
        issueStoredValue({
          ...rest,
          expiresOn: "expiresOn" in over ? over.expiresOn ?? null : body.expiresOn,
          postingDate: "postingDate" in over ? over.postingDate! : body.postingDate,
          memo: "memo" in over ? over.memo ?? null : body.memo,
        }),
      );
    };
    const identical = await retry({});
    assert.equal(identical.replayed, true, "the fully stated retry replays");
    assert.equal(identical.accountId, first.accountId);
    const statedConflict = (error: unknown) =>
      error instanceof StoredValueError && error.code === "stored_value_idempotency_conflict";
    await assert.rejects(retry({ expiresOn: null }), statedConflict, "dropping a stated expiry is a changed intent");
    await assert.rejects(retry({ expiresOn: "2027-06-01" }), statedConflict, "changing a stated expiry is a changed intent");
    await assert.rejects(retry({ postingDate: undefined as unknown as string }), statedConflict, "dropping a stated posting date is a changed intent");
    await assert.rejects(retry({ memo: null }), statedConflict, "dropping stated audit text is a changed intent");
    await assert.rejects(retry({ memo: "Gift for Noah" }), statedConflict, "changing audit text is a changed intent");
  } finally {
    await withBypass(() => dropScratchOrg(fx.orgId));
  }
});

test("an unchanged default retry replays without restating derived dates", { skip: !DB }, async () => {
  const fx = await seedScopeOrg();
  try {
    const scope = await liveScope(fx.orgId, fx.rootActor);
    const key = `scope-default-${randomUUID()}`;
    // No expiry, source, or posting date stated: all three derive from
    // clock and config at mint time, and the retry states none either.
    const body = {
      orgId: fx.orgId,
      allowedSubsidiaryIds: scope,
      subsidiaryId: fx.subsidiaryId,
      programId: fx.giftProgram,
      amountMinor: toUnits("22"),
      currency: "CAD",
      debitAccountId: fx.bank,
      idempotencyKey: key,
      actorId: fx.rootActor,
    };
    const first = await withOrgContext(fx.orgId, () => issueStoredValue(body));
    assert.ok(first.code && !first.replayed);
    const replayed = await withOrgContext(fx.orgId, () => issueStoredValue(body));
    assert.equal(replayed.replayed, true, "omitted defaults must not false-conflict on retry");
    assert.equal(replayed.code, null, "a replay never mints a second code");
    assert.equal(replayed.accountId, first.accountId);
    // Later config changes must not reinterpret the recorded defaults: the
    // program gains an expiry rule and a new name (which the default memo
    // embeds), yet the identical retry still replays the original effect.
    await withBypass(() => db.execute(sql`
      update stored_value_programs set name = 'Renamed gift cards', expiry_months = 6
       where id = ${fx.giftProgram} and org_id = ${fx.orgId}`));
    const afterConfig = await withOrgContext(fx.orgId, () => issueStoredValue(body));
    assert.equal(afterConfig.replayed, true, "config drift must not rewrite a recorded default");
    assert.equal(afterConfig.accountId, first.accountId);
  } finally {
    await withBypass(() => dropScratchOrg(fx.orgId));
  }
});

test("losing entity visibility refuses a replay without leaking the original receipt", { skip: !DB }, async () => {
  const fx = await seedScopeOrg();
  try {
    const scope = await liveScope(fx.orgId, fx.rootActor);
    const key = `scope-loss-${randomUUID()}`;
    const first = await withOrgContext(fx.orgId, () =>
      issueStoredValue({
        orgId: fx.orgId,
        allowedSubsidiaryIds: scope,
        subsidiaryId: fx.subsidiaryId,
        programId: fx.giftProgram,
        amountMinor: toUnits("30"),
        currency: "CAD",
        debitAccountId: fx.bank,
        postingDate: fx.date,
        idempotencyKey: key,
        actorId: fx.rootActor,
      }),
    );
    // The actor's grant narrows to the other entity after issuance.
    await withBypass(() => db.execute(sql`
      update app_roles set subsidiary_restriction = ${JSON.stringify({ mode: "list", subsidiaryIds: [fx.secondId] })}::jsonb
       where org_id = ${fx.orgId} and key = 'sv_root'`));
    const narrowed = await liveScope(fx.orgId, fx.rootActor);
    assert.ok(narrowed && !narrowed.has(fx.subsidiaryId));
    // The retry names the actor's remaining entity so subsidiary resolution
    // passes; the scoped lock on the now-hidden original still refuses.
    const error = await withOrgContext(fx.orgId, () =>
      issueStoredValue({
        orgId: fx.orgId,
        allowedSubsidiaryIds: narrowed,
        subsidiaryId: fx.secondId,
        programId: fx.giftProgram,
        amountMinor: toUnits("30"),
        currency: "CAD",
        debitAccountId: fx.bank,
        postingDate: fx.date,
        idempotencyKey: key,
        actorId: fx.rootActor,
      }),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(error instanceof ScopeNotFoundError, "the replay reads as missing once visibility is lost");
    assert.ok(!(error as { accountId?: unknown }).accountId, "no hidden account id rides the denial");
    assert.equal((await balanceOf(fx.orgId, first.accountId)).balance, toUnits("30").toString());
  } finally {
    await withBypass(() => dropScratchOrg(fx.orgId));
  }
});

test("store credit issues only to a visible customer; shared org-wide parties stay eligible", { skip: !DB }, async () => {
  const fx = await seedScopeOrg();
  try {
    const scope = await liveScope(fx.orgId, fx.rootActor);
    const foreignCustomer = await seedParty(fx, "Second Customer", fx.secondId);
    const ownCustomer = await seedParty(fx, "Root Customer", fx.subsidiaryId);
    const credit = (customerPartyId: string) =>
      withOrgContext(fx.orgId, () =>
        issueStoredValue({
          orgId: fx.orgId,
          allowedSubsidiaryIds: scope,
          subsidiaryId: fx.subsidiaryId,
          programId: fx.creditProgram,
          amountMinor: toUnits("15"),
          currency: "CAD",
          customerPartyId,
          debitAccountId: fx.bank,
          postingDate: fx.date,
          idempotencyKey: `scope-cust-${randomUUID()}`,
          actorId: fx.rootActor,
        }),
      );
    await assert.rejects(
      credit(foreignCustomer),
      (error: unknown) => error instanceof ScopeNotFoundError,
      "a foreign-entity customer reads as missing, never by name",
    );
    const own = await credit(ownCustomer);
    assert.ok(own.accountId, "the same-entity customer issues");
    // Parties without an entity are org-wide identity: no customerPartyId
    // scope check may exclude them, and the issue form keeps offering them.
    const shared = await seedParty(fx, "Shared Customer", null);
    const sharedIssue = await credit(shared);
    assert.ok(sharedIssue.accountId, "the shared org-wide customer issues");
  } finally {
    await withBypass(() => dropScratchOrg(fx.orgId));
  }
});

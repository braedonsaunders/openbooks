import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { installEngineSeams } from "../composition/install.ts";
import { db, withBypass, withOrgContext, withOrgTransaction } from "../platform/db.ts";
import { toUnits } from "../money/money.ts";
import { clearBalancingLegProviders } from "../journal/balancing-hooks.ts";
import { postEntry, type PostEntryInput } from "../journal/post-entry.ts";
import { createFund, getFund, listFunds, setFundPair } from "./funds.ts";
import { NonprofitError, NonprofitPostingError } from "./errors.ts";
import { provisionFundAccounting } from "./provision.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";
import { postDocument } from "../ledger/posting-document.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

function fundDimensions(fundId: string): { fund: string } {
  return { fund: fundId };
}

function giftEntry(org: ScratchOrg, entryNumber: string, operatingId: string, restrictedId: string): PostEntryInput {
  return {
    orgId: org.orgId,
    bookId: org.bookId,
    subsidiaryId: org.subsidiaryId,
    entryNumber,
    postingDate: org.date,
    periodId: org.periodId,
    origin: "gift",
    currency: "CAD",
    lines: [
      {
        accountId: org.accounts.bank,
        amount: "100.0000",
        subsidiaryId: org.subsidiaryId,
        currency: "CAD",
        extraDims: fundDimensions(operatingId),
      },
      {
        accountId: org.accounts.revenue,
        amount: "-100.0000",
        subsidiaryId: org.subsidiaryId,
        currency: "CAD",
        extraDims: fundDimensions(restrictedId),
      },
    ],
  };
}

async function postDirect(org: ScratchOrg, input: PostEntryInput) {
  return withOrgTransaction(org.orgId, () => postEntry(db, input));
}

async function account(org: ScratchOrg, actorId: string, type: "asset_current_other" | "liability_current_other", name: string): Promise<string> {
  const number = `F${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const result = await db.execute<{ id: string }>(sql`
    insert into accounts
      (org_id, number, name, type, is_summary, is_active, required_dimensions, created_by, updated_by)
    values (${org.orgId}, ${number}, ${name}, ${type}, false, true, '[]'::jsonb, ${actorId}, ${actorId})
    returning id
  `);
  assert.equal(result.rows.length, 1);
  return result.rows[0]!.id;
}

async function entryFundBalances(orgId: string, entryId: string) {
  return (await withOrgContext(orgId, () => db.execute<{ fundId: string; total: string; lineCount: number }>(sql`
    select extra_dims->>'fund' as "fundId", sum(amount)::text as total, count(*)::int as "lineCount"
      from journal_lines
     where org_id = ${orgId} and entry_id = ${entryId}
     group by extra_dims->>'fund' order by extra_dims->>'fund'
  `))).rows;
}

async function assertBalancedByFund(orgId: string, entryId: string, expectedFunds = 2) {
  const rows = await entryFundBalances(orgId, entryId);
  assert.equal(rows.length, expectedFunds);
  assert.ok(rows.every((row) => toUnits(row.total) === 0n));
  assert.ok(rows.every((row) => row.lineCount === 2));
}

test("fund balancing stays data-driven and fund postings use configured interfund pairs", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  let actors: string | undefined;
  try {
    await assert.rejects(
      createFund({
        orgId: org.orgId,
        code: "OFF-CHECK",
        name: "Disabled setup check",
        kind: "operating",
        restrictionClass: "without_donor_restrictions",
      }),
      (error) => error instanceof NonprofitError && error.code === "feature_off" &&
        error.message.includes("fundAccounting") && error.remedy.includes("Company Settings → Features"),
    );

    actors = await withBypass(() => createScratchUser(org.orgId, "Fund Controller", "admin"));
    await withOrgContext(org.orgId, async () => {
      const changed = await db.execute<{ id: string }>(sql`
        update orgs
           set settings = jsonb_set(
             coalesce(settings, '{}'::jsonb), '{features}',
             coalesce(settings->'features', '{}'::jsonb) || '{"nonprofit":true,"fundAccounting":true}'::jsonb,
             true
           )
         where id = ${org.orgId}
        returning id
      `);
      assert.equal(changed.rows.length, 1);
    });
    const classifications = {
      OPERATING: { kind: "operating" as const, restrictionClass: "without_donor_restrictions" },
    };
    const provision = () => provisionFundAccounting({
      orgId: org.orgId,
      defaultFund: { code: "OPERATING", name: "Operating Fund" },
      classifications,
      actorId: actors,
    });
    const initial = await provision();
    const restricted = await createFund({
      orgId: org.orgId,
      code: "SCHOLARSHIP",
      name: "Youth Scholarship Fund",
      kind: "restricted",
      restrictionClass: "with_donor_restrictions",
      actorId: actors,
    });
    const operatingId = initial.defaultFundId;
    const dueFromAccount = await withOrgContext(org.orgId, () =>
      account(org, actors!, "asset_current_other", "Due from other funds"),
    );
    const dueToAccount = await withOrgContext(org.orgId, () =>
      account(org, actors!, "liability_current_other", "Due to other funds"),
    );

    await withOrgContext(org.orgId, async () => {
      const result = await db.execute<{ id: string }>(sql`
        update segment_definitions set is_balancing = false
         where org_id = ${org.orgId} and id = ${initial.segmentId}
        returning id
      `);
      assert.equal(result.rows.length, 1);
    });
    clearBalancingLegProviders();
    const unmatched = giftEntry(org, `FUND-BEFORE-${randomUUID()}`, operatingId, restricted.id);
    const first = await postDirect(org, unmatched);
    assert.equal(first.lines.length, 2);

    const adopted = await provisionFundAccounting({
      orgId: org.orgId,
      defaultFund: { code: "OPERATING", name: "Operating Fund" },
      classifications: {
        OPERATING: { kind: "operating", restrictionClass: "without_donor_restrictions" },
        SCHOLARSHIP: { kind: "restricted", restrictionClass: "with_donor_restrictions" },
      },
      actorId: actors,
    });
    assert.ok(adopted.historicalUnbalancedByFund.some((row) => row.fundId === operatingId && row.unbalancedEntries === 1));
    assert.ok(adopted.historicalUnbalancedByFund.some((row) => row.fundId === restricted.id && row.unbalancedEntries === 1));

    installEngineSeams();
    await assert.rejects(
      postDirect(org, { ...unmatched, entryNumber: `FUND-NO-PAIR-${randomUUID()}` }),
      (error) => error instanceof NonprofitPostingError &&
        error.code === "interfund_pair_missing" &&
        error.message.includes("SCHOLARSHIP") && error.message.includes("OPERATING") &&
        error.remedy.includes("Setup → Nonprofit → Interfund pairs"),
    );

    await setFundPair({
      orgId: org.orgId,
      fromFundId: restricted.id,
      toFundId: operatingId,
      dueFromAccountId: dueFromAccount,
      dueToAccountId: dueToAccount,
      actorId: actors,
      reason: "Pair restricted and operating funds for balancing-leg assertions",
    });
    const gift = await postDirect(org, { ...unmatched, entryNumber: `GIFT-${randomUUID()}` });
    await assertBalancedByFund(org.orgId, gift.entryId);

    const documentId = randomUUID();
    await withOrgContext(org.orgId, async () => {
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, status, document_number, subsidiary_id, party_id,
           document_date, currency, subtotal, tax_total, total, created_by)
        values
          (${documentId}, ${org.orgId}, 'journal', 'draft', ${`JRN-${documentId}`},
           ${org.subsidiaryId}, ${org.customerId}, ${org.date}, 'CAD', 100, 0, 100, ${actors})
      `);
      await db.execute(sql`
        insert into document_lines
          (org_id, document_id, line_number, account_id, subsidiary_id, amount,
           quantity, unit_price, tax_amount, tax_input_amount, extra_dims)
        values
          (${org.orgId}, ${documentId}, 1, ${org.accounts.bank}, ${org.subsidiaryId},
           100, 1, 100, 0, 100, ${JSON.stringify(fundDimensions(operatingId))}::jsonb),
          (${org.orgId}, ${documentId}, 2, ${org.accounts.revenue}, ${org.subsidiaryId},
           -100, 1, -100, 0, -100, ${JSON.stringify(fundDimensions(restricted.id))}::jsonb)
      `);
      const approved = await db.execute<{ id: string }>(sql`
        update documents set status = 'approved'
         where org_id = ${org.orgId} and id = ${documentId}
        returning id
      `);
      assert.equal(approved.rows.length, 1);
    });
    const documentEntry = await withOrgContext(org.orgId, () =>
      postDocument(documentId, {
        control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
      }, { deferEffects: true }),
    );
    await assertBalancedByFund(org.orgId, documentEntry);

    const fundless = await postDirect(org, {
      ...giftEntry(org, `FUND-DEFAULT-${randomUUID()}`, operatingId, operatingId),
      lines: [
        { accountId: org.accounts.bank, amount: "25.0000", currency: "CAD" },
        { accountId: org.accounts.cogs, amount: "-25.0000", currency: "CAD" },
      ],
    });
    const stamped = await entryFundBalances(org.orgId, fundless.entryId);
    assert.deepEqual(stamped.map((row) => row.fundId), [operatingId]);
    assert.equal(stamped[0]!.lineCount, 2);

    await withOrgContext(org.orgId, async () => {
      const result = await db.execute<{ id: string }>(sql`
        update accounts set required_dimensions = '["fund"]'::jsonb
         where org_id = ${org.orgId} and id = ${org.accounts.bank}
        returning id
      `);
      assert.equal(result.rows.length, 1);
    });
    await assert.rejects(
      postDirect(org, {
        ...giftEntry(org, `FUND-REQUIRED-${randomUUID()}`, operatingId, operatingId),
        lines: [
          { accountId: org.accounts.bank, amount: "25.0000", currency: "CAD" },
          { accountId: org.accounts.cogs, amount: "-25.0000", currency: "CAD" },
        ],
      }),
      (error) => {
        const wrapped = error as Error & { cause?: { message?: string } };
        return /requires segment fund/.test(`${wrapped.message} ${wrapped.cause?.message ?? ""}`);
      },
    );

    await assert.rejects(
      withOrgContext(org.orgId, () => db.execute(sql`
        update funds set restriction_class = 'without_donor_restrictions'
         where org_id = ${org.orgId} and id = ${restricted.id}
      `)),
      (error) => {
        const wrapped = error as Error & { cause?: { message?: string } };
        return /fund SCHOLARSHIP restriction class cannot change while \d+ posted journal lines carry it/.test(
          `${wrapped.message} ${wrapped.cause?.message ?? ""}`,
        );
      },
    );
    await assert.rejects(
      withOrgContext(org.orgId, () => db.execute(sql`
        update segment_definitions set is_balancing = false
         where org_id = ${org.orgId} and id = ${initial.segmentId}
      `)),
      (error) => {
        const wrapped = error as Error & { cause?: { message?: string } };
        return /segment fund cannot stop balancing while \d+ posted journal lines carry it/.test(
          `${wrapped.message} ${wrapped.cause?.message ?? ""}`,
        );
      },
    );
  } finally {
    clearBalancingLegProviders();
    await dropScratchOrg(org.orgId);
  }
});

test("fund readers return the drawer projection with same-org isolation", { skip: !DB }, async (t) => {
  const org = await withBypass(() => createScratchOrg());
  t.after(() => dropScratchOrg(org.orgId));
  const enabled = await withOrgContext(org.orgId, () => db.execute<{ id: string }>(sql`
    update orgs set settings=coalesce(settings,'{}'::jsonb)||'{"features":{"nonprofit":true,"fundAccounting":true}}'::jsonb where id=${org.orgId} returning id`));
  assert.equal(enabled.rows.length, 1);
  const setup = await provisionFundAccounting({ orgId: org.orgId, defaultFund: { code: "READER", name: "Reader Fund" },
    classifications: { READER: { kind: "operating", restrictionClass: "without_donor_restrictions" } } });
  const second = await createFund({ orgId: org.orgId, code: "ARCHIVE", name: "Archive Fund",
    kind: "operating", restrictionClass: "without_donor_restrictions" });
  const page = await withOrgContext(org.orgId, () => listFunds({ orgId: org.orgId, limit: 1 }));
  assert.deepEqual([page.total, ...page.funds.map((fund) => fund.code)], [2, "ARCHIVE"]);
  const found = await withOrgContext(org.orgId, () => getFund({ orgId: org.orgId, fundId: second.id }));
  assert.deepEqual(found, page.funds[0]);
  assert.equal(await withOrgContext(org.orgId, () => getFund({ orgId: randomUUID(), fundId: setup.defaultFundId })), null);
  assert.equal(await withOrgContext(org.orgId, () => getFund({ orgId: org.orgId, fundId: randomUUID() })), null);
});

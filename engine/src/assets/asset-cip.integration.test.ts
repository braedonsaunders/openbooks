import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgContext, withOrgTransaction } from "../platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  grantScratchPermissions,
  seedFlowActors,
  seedPostingAccount,
} from "../testing/fixtures.ts";
import { markEntryReversed, postEntry } from "../journal/post-entry.ts";
import { AssetRefusal } from "./asset-refusal.ts";
import {
  capitalizeCip,
  cipReconciliation,
  createCipRecord,
  linkCipCosts,
  listCipCandidateLines,
  reverseCipCapitalization,
  unlinkCipCost,
} from "./asset-cip.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

type Org = Awaited<ReturnType<typeof createScratchOrg>>;

async function refusedWith(code: string, run: () => Promise<unknown>): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof AssetRefusal, `expected AssetRefusal ${code}, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

async function rejectsMatching(run: Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    for (
      let current: unknown = error;
      current instanceof Error;
      current = (current as Error & { cause?: unknown }).cause
    ) {
      if (pattern.test(current.message)) return true;
    }
    return false;
  });
}

async function setup(org: Org) {
  const actors = await seedFlowActors(org.orgId);
  await grantScratchPermissions(org.orgId, actors.adminId, ["assets.capitalize"]);
  return withOrgContext(org.orgId, async () => {
    await db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{features}',
        coalesce(settings->'features', '{}'::jsonb) || '{"constructionInProgress": true}'::jsonb)
       where id = ${org.orgId}`);
    const cip = await seedPostingAccount(
      org.orgId,
      "1650",
      "Construction in progress",
      "asset_fixed",
    );
    const buildings = await seedPostingAccount(org.orgId, "1610", "Buildings", "asset_fixed");
    const accumulated = await seedPostingAccount(
      org.orgId,
      "1619",
      "Accumulated depreciation — buildings",
      "asset_fixed",
    );
    const depreciation = await seedPostingAccount(
      org.orgId,
      "6110",
      "Depreciation — buildings",
      "expense",
    );
    const repairs = await seedPostingAccount(
      org.orgId,
      "6300",
      "Repairs and maintenance",
      "expense",
    );
    const categoryId = randomUUID();
    await db.execute(sql`
      insert into asset_categories
        (id, org_id, name, asset_account_id, accumulated_depreciation_account_id, depreciation_expense_account_id,
         gain_loss_account_id, default_method, default_life_months, default_convention, tax_attributes, is_active)
      values (${categoryId}, ${org.orgId}, 'Buildings', ${buildings}, ${accumulated}, ${depreciation}, ${depreciation},
              'straight_line', 480, 'full_month', '{}'::jsonb, true)`);
    return { actors, cip, buildings, repairs, categoryId };
  });
}

async function postCost(
  org: Org,
  cipAccount: string,
  amount: string,
): Promise<{ entryId: string; lineId: string }> {
  const posted = await withOrgContext(org.orgId, () =>
    postEntry(db, {
      orgId: org.orgId,
      bookId: org.bookId,
      subsidiaryId: org.subsidiaryId,
      entryNumber: `CIP-COST-${randomUUID()}`,
      postingDate: org.date,
      periodId: org.periodId,
      origin: "manual",
      currency: "CAD",
      lines: [
        { accountId: cipAccount, amount, memo: "Contractor progress billing" },
        { accountId: org.accounts.bank, amount: `-${amount}` },
      ],
    }),
  );
  return { entryId: posted.entryId, lineId: posted.lines[0]!.id };
}

async function balance(org: Org, accountId: string): Promise<string> {
  const row = (
    await withOrgContext(org.orgId, () =>
      db.execute<{ total: string }>(
        sql`
    select coalesce(sum(jl.amount), 0)::numeric(19,4)::text as total from journal_lines jl
      join journal_entries je on je.org_id = jl.org_id and je.id = jl.entry_id and je.status in ('posted', 'reversed')
     where jl.org_id = ${org.orgId} and jl.account_id = ${accountId}`,
        "objects",
      ),
    )
  )[0];
  return row!.total;
}

async function cipRow(org: Org, id: string) {
  return (
    await withOrgContext(org.orgId, () =>
      db.execute<{ status: string; acquisition_cost: string }>(
        sql`
    select status, acquisition_cost::text as acquisition_cost from fixed_assets where org_id = ${org.orgId} and id = ${id}`,
        "objects",
      ),
    )
  )[0]!;
}

test(
  "construction in progress links GL cost, capitalizes part into an asset and expense, and reconciles to the CIP account",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const { actors, cip, buildings, repairs, categoryId } = await setup(org);
      const record = await createCipRecord(org.orgId, {
        actorId: actors.adminId,
        subsidiaryId: org.subsidiaryId,
        categoryId,
        name: "Warehouse expansion",
        cipAccountId: cip,
      });
      const cost = await postCost(org, cip, "10000.00");
      const candidates = await listCipCandidateLines(org.orgId, { cipAssetId: record.id });
      assert.deepEqual(
        candidates.map((line) => [line.journalLineId, line.amount]),
        [[cost.lineId, "10000.0000"]],
      );
      const linked = await linkCipCosts(org.orgId, {
        cipAssetId: record.id,
        journalLineIds: [cost.lineId],
        actorId: actors.adminId,
      });
      assert.equal(linked.balance.open, "10000.0000");
      assert.deepEqual(await cipRow(org, record.id), {
        status: "construction",
        acquisition_cost: "10000.0000",
      });
      await refusedWith("source_already_linked", () =>
        linkCipCosts(org.orgId, {
          cipAssetId: record.id,
          journalLineIds: [cost.lineId],
          actorId: actors.adminId,
        }),
      );
      // The carried cost of a CIP record moves only through the subledger.
      await rejectsMatching(
        withOrgContext(org.orgId, () =>
          db.execute(sql`
        update fixed_assets set acquisition_cost = 1 where org_id = ${org.orgId} and id = ${record.id}`),
        ),
        /construction-in-progress cost moves only/,
      );
      // A linked source cannot be reversed underneath the subledger.
      await rejectsMatching(
        withOrgTransaction(org.orgId, () =>
          markEntryReversed(db, {
            orgId: org.orgId,
            entryId: cost.entryId,
            actorId: actors.adminId,
          }),
        ),
        /unlink the cost/,
      );

      const request = {
        idempotencyKey: randomUUID(),
        cipAssetId: record.id,
        capitalizedOn: org.date,
        reason: "Phase one complete",
        lines: [
          { kind: "asset" as const, name: "Warehouse phase one", categoryId, amount: "7000.00" },
          {
            kind: "expense" as const,
            expenseAccountId: repairs,
            amount: "1000.00",
            memo: "Site cleanup is not capitalizable",
          },
        ],
      };
      const capitalized = await capitalizeCip(org.orgId, request, { actorId: actors.adminId });
      assert.equal(capitalized.capitalized, "7000.0000");
      assert.equal(capitalized.expensed, "1000.0000");
      assert.equal(capitalized.remaining, "2000.0000");
      assert.equal(await balance(org, cip), "2000.0000");
      assert.equal(await balance(org, buildings), "7000.0000");
      assert.equal(await balance(org, repairs), "1000.0000");
      assert.deepEqual(await cipRow(org, record.id), {
        status: "construction",
        acquisition_cost: "2000.0000",
      });
      const replay = await capitalizeCip(org.orgId, request, { actorId: actors.adminId });
      assert.equal(replay.replayed, true);
      assert.equal(await balance(org, cip), "2000.0000", "a replay posts nothing");

      const recon = await cipReconciliation(org.orgId, { asOf: org.date });
      assert.deepEqual(
        recon.map((row) => [row.accountId, row.subledger, row.ledger, row.difference]),
        [[cip, "2000.0000", "2000.0000", "0.0000"]],
      );

      await refusedWith("capitalization_exceeds_balance", () =>
        capitalizeCip(
          org.orgId,
          {
            ...request,
            idempotencyKey: randomUUID(),
            lines: [{ kind: "asset", name: "Too much", categoryId, amount: "2000.01" }],
          },
          { actorId: actors.adminId },
        ),
      );
      const costId = (
        await withOrgContext(org.orgId, () =>
          db.execute<{ id: string }>(
            sql`
        select id from asset_cip_costs where org_id = ${org.orgId} and cip_asset_id = ${record.id}`,
            "objects",
          ),
        )
      )[0]!.id;
      await refusedWith("cip_balance_negative", () =>
        unlinkCipCost(org.orgId, { costId, reason: "Wrong project", actorId: actors.adminId }),
      );

      const reversal = await reverseCipCapitalization(org.orgId, {
        capitalizationId: capitalized.capitalizationId,
        date: org.date,
        reason: "Booked to the wrong phase",
        actorId: actors.adminId,
      });
      assert.equal(reversal.removedAssets.length, 1);
      assert.equal(await balance(org, cip), "10000.0000");
      assert.equal(await balance(org, buildings), "0.0000");
      assert.deepEqual(await cipRow(org, record.id), {
        status: "construction",
        acquisition_cost: "10000.0000",
      });
      await refusedWith("capitalization_reversed", () =>
        capitalizeCip(org.orgId, request, { actorId: actors.adminId }),
      );

      const full = await capitalizeCip(
        org.orgId,
        {
          idempotencyKey: randomUUID(),
          cipAssetId: record.id,
          capitalizedOn: org.date,
          reason: "Complete",
          lines: [
            {
              kind: "asset",
              name: "Warehouse",
              categoryId,
              amount: "10000.00",
              placeInService: true,
            },
          ],
        },
        { actorId: actors.adminId },
      );
      assert.equal(full.remaining, "0.0000");
      assert.deepEqual(await cipRow(org, record.id), {
        status: "capitalized",
        acquisition_cost: "0.0000",
      });
      const placed = (
        await withOrgContext(org.orgId, () =>
          db.execute<{ status: string; in_service_on: string }>(
            sql`
        select status, in_service_on::text as in_service_on from fixed_assets where org_id = ${org.orgId} and id = ${full.assets[0]!.id}`,
            "objects",
          ),
        )
      )[0]!;
      assert.deepEqual(placed, { status: "in_service", in_service_on: org.date });
      const more = await postCost(org, cip, "50.00");
      await refusedWith("cip_closed", () =>
        linkCipCosts(org.orgId, {
          cipAssetId: record.id,
          journalLineIds: [more.lineId],
          actorId: actors.adminId,
        }),
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "construction in progress refuses foreign accounts, other organizations and actors without the duty",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const other = await createScratchOrg();
    try {
      const { actors, cip, repairs, categoryId } = await setup(org);
      const otherActors = await seedFlowActors(other.orgId);
      await refusedWith("cip_account_invalid", () =>
        createCipRecord(org.orgId, {
          actorId: actors.adminId,
          subsidiaryId: org.subsidiaryId,
          categoryId,
          name: "Bad",
          cipAccountId: repairs,
        }),
      );
      await refusedWith("permission_required", () =>
        createCipRecord(org.orgId, {
          actorId: actors.outsiderId,
          subsidiaryId: org.subsidiaryId,
          categoryId,
          name: "Nope",
          cipAccountId: cip,
        }),
      );
      const record = await createCipRecord(org.orgId, {
        actorId: actors.adminId,
        subsidiaryId: org.subsidiaryId,
        categoryId,
        name: "Fit-out",
        cipAccountId: cip,
      });
      const wrongAccount = await withOrgContext(org.orgId, () =>
        postEntry(db, {
          orgId: org.orgId,
          bookId: org.bookId,
          subsidiaryId: org.subsidiaryId,
          entryNumber: `X-${randomUUID()}`,
          postingDate: org.date,
          periodId: org.periodId,
          origin: "manual",
          currency: "CAD",
          lines: [
            { accountId: repairs, amount: "10" },
            { accountId: org.accounts.bank, amount: "-10" },
          ],
        }),
      );
      await refusedWith("source_wrong_account", () =>
        linkCipCosts(org.orgId, {
          cipAssetId: record.id,
          journalLineIds: [wrongAccount.lines[0]!.id],
          actorId: actors.adminId,
        }),
      );
      await refusedWith("cip_not_found", () =>
        linkCipCosts(other.orgId, {
          cipAssetId: record.id,
          journalLineIds: [wrongAccount.lines[0]!.id],
          actorId: otherActors.adminId,
        }),
      );
    } finally {
      await dropScratchOrg(org.orgId);
      await dropScratchOrg(other.orgId);
    }
  },
);

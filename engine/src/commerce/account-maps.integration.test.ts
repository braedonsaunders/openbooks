import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { listAccountMaps, resolveAccountMap, upsertAccountMap } from "./account-maps.ts";
import { CommerceError } from "./errors.ts";
import { db, withOrgContext } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrgReporting,
  type ScratchOrg,
} from "../testing/fixtures.ts";

const DB = { skip: !process.env.OPENBOOKS_DB_URL };

async function setup(
  run: (org: ScratchOrg, actor: string, channelId: string) => Promise<void>,
  opts: { feature?: boolean } = {},
): Promise<void> {
  const org = await createScratchOrg();
  try {
    const actor = await withOrgContext(org.orgId, () => createScratchUser(org.orgId, "Map tester", "admin"));
    await withOrgContext(org.orgId, async () => {
      const result = await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features','{}'::jsonb) || ${JSON.stringify({ salesChannels: opts.feature !== false })}::jsonb, true) where id = ${org.orgId}`);
      assert.equal(result.rowCount, 1);
    });
    const channelId = (await withOrgContext(org.orgId, () => db.execute<{ id: string }>(sql`
      insert into sales_channels (org_id, kind, name, status, currency, external_account, settings, created_by, updated_by)
      values (${org.orgId}, 'shopify', 'Maple Shop', 'active', 'USD', 'maple.myshopify.com', '{}'::jsonb, ${actor}, ${actor})
      returning id`))).rows[0]!.id;
    await run(org, actor, channelId);
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
}

test("an unmapped role refuses naming the channel, role, key, and date", DB, async () => {
  await setup(async (org, _actor, channelId) => {
    await assert.rejects(
      withOrgContext(org.orgId, () => resolveAccountMap(org.orgId, channelId, "gateway_clearing", "shopify_payments", "2026-09-14")),
      (error: unknown) => {
        assert.ok(error instanceof CommerceError);
        assert.equal(error.code, "channel_map_unmapped");
        for (const part of ["Maple Shop", "gateway_clearing", "shopify_payments", "2026-09-14"]) {
          assert.ok(error.message.includes(part), `names ${part}: ${error.message}`);
        }
        assert.ok(error.remedy.includes("Settings"), `names the remedy: ${error.remedy}`);
        return true;
      },
    );
  });
});

test("effective dating returns the row in force on the date", DB, async () => {
  await setup(async (org, actor, channelId) => {
    const first = await upsertAccountMap(org.orgId, actor, {
      channelId,
      role: "revenue",
      accountId: org.accounts.revenue,
      effectiveFrom: "2026-01-01",
    });
    assert.equal(first.effectiveTo, null);
    const second = await upsertAccountMap(org.orgId, actor, {
      channelId,
      role: "revenue",
      accountId: org.accounts.bank,
      effectiveFrom: "2026-06-01",
    });
    assert.notEqual(second.id, first.id);
    assert.equal(await withOrgContext(org.orgId, () => resolveAccountMap(org.orgId, channelId, "revenue", "", "2026-03-01")), org.accounts.revenue);
    assert.equal(await withOrgContext(org.orgId, () => resolveAccountMap(org.orgId, channelId, "revenue", "", "2026-05-31")), org.accounts.revenue);
    assert.equal(await withOrgContext(org.orgId, () => resolveAccountMap(org.orgId, channelId, "revenue", "", "2026-06-01")), org.accounts.bank);
    // The prior open row closes the day before the successor starts.
    const rows = await withOrgContext(org.orgId, () => listAccountMaps(org.orgId, channelId));
    assert.deepEqual(
      rows.filter((row) => row.role === "revenue").map((row) => row.effectiveTo),
      ["2026-05-31", null],
    );
    // Repeating the identical map is idempotent, not a second row.
    const repeat = await upsertAccountMap(org.orgId, actor, {
      channelId,
      role: "revenue",
      accountId: org.accounts.bank,
      effectiveFrom: "2026-06-01",
    });
    assert.equal(repeat.id, second.id);
    // Keys scope independently: the Ontario tax map never answers for Quebec.
    await upsertAccountMap(org.orgId, actor, {
      channelId,
      role: "sales_tax_liability",
      key: "CA-ON",
      accountId: org.accounts.taxOutput,
      effectiveFrom: "2026-01-01",
    });
    assert.equal(await withOrgContext(org.orgId, () => resolveAccountMap(org.orgId, channelId, "sales_tax_liability", "CA-ON", "2026-09-14")), org.accounts.taxOutput);
    await assert.rejects(withOrgContext(org.orgId, () => resolveAccountMap(org.orgId, channelId, "sales_tax_liability", "CA-QC", "2026-09-14")), /CA-QC/);
    // A backdated map at or before the open row refuses instead of overlapping it.
    await assert.rejects(
      upsertAccountMap(org.orgId, actor, {
        channelId,
        role: "revenue",
        accountId: org.accounts.revenue,
        effectiveFrom: "2026-06-01",
      }),
      /at or before the open row/,
    );
  });
});

test("storage arbitrates the overlap the engine cannot see", DB, async () => {
  await setup(async (org, actor, channelId) => {
    await upsertAccountMap(org.orgId, actor, {
      channelId,
      role: "discount",
      accountId: org.accounts.revenue,
      effectiveFrom: "2026-01-01",
    });
    // A concurrent writer slipping past the row lock meets the EXCLUDE constraint, not a silent second open row.
    await assert.rejects(
      withOrgContext(org.orgId, () => db.execute(sql`
        insert into sales_channel_account_maps (org_id, channel_id, role, key, account_id, effective_from, created_by, updated_by)
        values (${org.orgId}, ${channelId}, 'discount', '', ${org.accounts.bank}, '2026-03-01', ${actor}, ${actor})`)),
      (error: unknown) => {
        const cause = error instanceof Error && "cause" in error
          ? String((error as { cause?: unknown }).cause)
          : String(error);
        return cause.includes('exclusion constraint "sales_channel_account_maps_no_overlap"');
      },
    );
    assert.equal((await withOrgContext(org.orgId, () => listAccountMaps(org.orgId, channelId))).filter((row) => row.role === "discount").length, 1);
  });
});

test("maps refuse without the feature, the account, or the role", DB, async () => {
  await setup(async (org, actor, channelId) => {
    await assert.rejects(
      upsertAccountMap(org.orgId, actor, { channelId, role: "revenue", accountId: org.accounts.revenue, effectiveFrom: "2026-01-01" }),
      (error: unknown) => error instanceof CommerceError && error.code === "feature_off",
    );
  }, { feature: false });
  await setup(async (org, actor, channelId) => {
    await assert.rejects(
      upsertAccountMap(org.orgId, actor, { channelId, role: "nope", accountId: org.accounts.revenue, effectiveFrom: "2026-01-01" }),
      /not a channel posting role/,
    );
    await assert.rejects(
      upsertAccountMap(org.orgId, actor, { channelId, role: "revenue", accountId: "00000000-0000-0000-0000-000000000000", effectiveFrom: "2026-01-01" }),
      /does not belong to this organization/,
    );
    await assert.rejects(
      upsertAccountMap(org.orgId, actor, { channelId, role: "revenue", accountId: org.accounts.revenue, effectiveFrom: "next Friday" }),
      /not a calendar date/,
    );
  });
});

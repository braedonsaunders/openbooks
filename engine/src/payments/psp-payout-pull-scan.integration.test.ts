import assert from "node:assert/strict";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgContext } from "../platform/db.ts";
import { sealJson } from "../platform/secrets.ts";
import {
  runDuePspPayoutPulls,
  type PullFetchFn,
} from "./psp-pull.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

function stubFetch(): PullFetchFn {
  return (async (url: string) => {
    if (url.includes("/v1/balance_transactions")) {
      return {
        status: 200,
        json: async () => ({
          data: [
            { id: "txn_scan_1", type: "charge", amount: 10_000, fee: 290, net: 9_710, currency: "cad" },
          ],
        }),
      };
    }
    return {
      status: 200,
      json: async () => ({
        data: [{ id: "po_scan_1", currency: "cad", arrival_date: 1_783_123_200 }],
      }),
    };
  }) as PullFetchFn;
}

async function pullConfig(orgId: string, userId: string, bank: string, fee: string, fx: string, clearing: string): Promise<void> {
  await db.execute(sql`
    insert into psp_provider_configs
      (org_id, provider, display_name, is_enabled, acceptance_enabled, pull_enabled,
       default_bank_account_id, default_fee_account_id, default_dispute_account_id,
       default_fx_account_id, default_clearing_account_id,
       secrets, created_by, updated_by)
    values (${orgId}, 'stripe', 'Stripe', true, false, true,
            ${bank}, ${fee}, ${fee}, ${fx}, ${clearing},
            ${sealJson({ apiKey: "sk_test_scan" }, { orgId, purpose: "payment.provider.secrets" })}, ${userId}, ${userId})`);
}

test("scheduled pull imports each payout once across refetches", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const userId = await createScratchUser(org.orgId, "Pull Scanner", "admin");
    await db.execute(sql`
      update orgs set settings = settings || '{"features":{"banking":true}}'::jsonb where id = ${org.orgId}`);
    await pullConfig(org.orgId, userId, org.accounts.bank, org.accounts.adjustment, org.accounts.fxGainLoss, org.accounts.clearing);

    // Scoped to the test org: the unscoped scheduler tick would also see
    // pooled scratch orgs from other tests holding pull configs.
    const first = await withOrgContext(org.orgId, () => runDuePspPayoutPulls(new Date("2026-07-10T12:00:00Z"), stubFetch()));
    assert.equal(first.failed, 0, `scan errors: ${JSON.stringify(first.orgErrors)}`);
    assert.equal(first.ran, 1);
    const batches = (await db.execute<{ external_ref: string }>(sql`
      select external_ref from psp_settlement_batches
       where org_id = ${org.orgId} and provider = 'stripe'
    `)).rows;
    assert.deepEqual(batches.map((row) => row.external_ref), ["po_scan_1"]);

    const second = await withOrgContext(org.orgId, () => runDuePspPayoutPulls(new Date("2026-07-10T12:00:00Z"), stubFetch()));
    assert.equal(second.failed, 0, `rescan errors: ${JSON.stringify(second.orgErrors)}`);
    const rescan = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from psp_settlement_batches
       where org_id = ${org.orgId} and provider = 'stripe'
    `)).rows[0]!.n;
    assert.equal(rescan, 1, "a refetch converges instead of duplicating");

    const cursor = (await db.execute<{ last_pull_at: string | null }>(sql`
      select last_pull_at from psp_provider_configs where org_id = ${org.orgId} and provider = 'stripe'`)).rows[0];
    assert.ok(cursor!.last_pull_at, "pull cursor advances after the scan");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("scheduled pull skips orgs with the banking feature off", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const userId = await createScratchUser(org.orgId, "Pull Scanner", "admin");
    await db.execute(sql`
      update orgs set settings = settings || '{"features":{"banking":false}}'::jsonb where id = ${org.orgId}`);
    await pullConfig(org.orgId, userId, org.accounts.bank, org.accounts.adjustment, org.accounts.fxGainLoss, org.accounts.clearing);
    const result = await withOrgContext(org.orgId, () => runDuePspPayoutPulls(new Date("2026-07-10T12:00:00Z"), stubFetch()));
    assert.equal(result.ran, 0);
    assert.equal(result.failed, 0);
    const batches = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from psp_settlement_batches
       where org_id = ${org.orgId} and provider = 'stripe'
    `)).rows[0]!.n;
    assert.equal(batches, 0, "a gated-off org pulls nothing");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

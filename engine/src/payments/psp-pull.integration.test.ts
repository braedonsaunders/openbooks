import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { sealJson } from "../platform/secrets.ts";
import {
  fetchStripePayoutSettlement,
  importPulledSettlements,
  type PullFetchFn,
} from "./psp-pull.ts";
import { postSettlementBatch } from "./psp-settlement.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

function stubFetch(body: unknown): PullFetchFn {
  return (async () => ({ status: 200, json: async () => body })) as PullFetchFn;
}

async function ensureOpenPeriod(orgId: string, periodId: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const [year, month] = today.split("-").map(Number) as [number, number, number];
  await db.execute(sql`
    insert into accounting_periods
      (org_id, fiscal_calendar_id, fiscal_year, period_number, name,
       starts_on, ends_on, is_adjustment)
    select ${orgId}, fiscal_calendar_id, ${year}, ${month}, ${today.slice(0, 7)},
           ${`${year}-${String(month).padStart(2, "0")}-01`},
           ${new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)}, false
      from accounting_periods
     where id = ${periodId}
    on conflict (org_id, fiscal_calendar_id, fiscal_year, period_number) do nothing
  `);
}

async function pullConfig(orgId: string, userId: string, bank: string, fee: string, fx: string, clearing: string, pullEnabled: boolean): Promise<void> {
  await db.execute(sql`
    insert into psp_provider_configs
      (org_id, provider, display_name, is_enabled, acceptance_enabled, pull_enabled,
       default_bank_account_id, default_fee_account_id, default_dispute_account_id,
       default_fx_account_id, default_clearing_account_id,
       secrets, created_by, updated_by)
    values (${orgId}, 'stripe', 'Stripe', true, false, ${pullEnabled},
            ${bank}, ${fee}, ${fee}, ${fx}, ${clearing},
            ${sealJson({ apiKey: "sk_test_pull" }, { orgId, purpose: "payment.provider.secrets" })}, ${userId}, ${userId})`);
}

const balanceBody = {
  data: [
    { id: "txn_pull_1", type: "charge", amount: 10_000, fee: 290, net: 9_710, currency: "cad" },
  ],
};

test("a pulled payout imports once, posts, and advances the cursor", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const userId = await createScratchUser(org.orgId, "Pull Tester", "admin");
    await db.execute(sql`
      update orgs set settings = settings || '{"features":{"banking":true}}'::jsonb where id = ${org.orgId}`);
    await ensureOpenPeriod(org.orgId, org.periodId);
    await pullConfig(org.orgId, userId, org.accounts.bank, org.accounts.adjustment, org.accounts.fxGainLoss, org.accounts.clearing, true);

    const parsed = await fetchStripePayoutSettlement(
      { apiKey: "sk_test_pull" },
      { id: `po_pull_${randomUUID().slice(0, 8)}`, currency: "CAD", arrivalDate: "2026-07-10" },
      stubFetch(balanceBody),
    );
    const first = await importPulledSettlements(org.orgId, "stripe", [parsed], userId, null);
    assert.equal(first.batchIds.length, 1);
    const second = await importPulledSettlements(org.orgId, "stripe", [parsed], userId, null);
    assert.deepEqual(second.batchIds, first.batchIds);

    const posted = await postSettlementBatch(org.orgId, first.batchIds[0]!, userId, null);
    assert.ok(posted.entryId);

    const cursor = (await db.execute<{ last_pull_at: string | null }>(sql`
      select last_pull_at from psp_provider_configs where org_id = ${org.orgId} and provider = 'stripe'`)).rows[0];
    assert.ok(cursor!.last_pull_at, "pull cursor advances after import");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("pull refuses when the provider config has it off", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const userId = await createScratchUser(org.orgId, "Pull Tester", "admin");
    await pullConfig(org.orgId, userId, org.accounts.bank, org.accounts.adjustment, org.accounts.fxGainLoss, org.accounts.clearing, false);
    const parsed = await fetchStripePayoutSettlement(
      { apiKey: "sk_test_pull" },
      { id: "po_off", currency: "CAD", arrivalDate: "2026-07-10" },
      stubFetch(balanceBody),
    );
    await assert.rejects(
      () => importPulledSettlements(org.orgId, "stripe", [parsed], userId, null),
      /not enabled for stripe/,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

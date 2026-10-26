import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";

// Transfer legs name any active bank or credit-card account the banking module
// manages; deposit and check funding keeps the reconcilable bank-only picker.
const { db, withBypassContext } = await import("@openbooks/engine/platform/db");
const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/testing/fixtures");
const { bankAccountOptions, transferAccountOptions } = await import("./documents.ts");
const { listReconcilableBankAccounts } = await import("./banking-accounts.ts");

async function insertAccount(
  orgId: string,
  number: string,
  type: string,
  flags: { reconcilable?: boolean; isActive?: boolean; isSummary?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate,
      reconcilable, currency_restriction, required_dimensions, custom, subsidiary_include_children)
    values (${id}, ${orgId}, ${number}, ${`Fixture ${number}`}, ${type}, ${flags.isSummary ?? false},
      ${flags.isActive ?? true}, false, ${flags.reconcilable ?? true}, 'CAD', '[]'::jsonb, '{}'::jsonb, true)`);
  return id;
}

test("a reconcilable credit line is a Banking account; other liabilities need the reconcilable flag", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const creditLine = await withBypassContext(() =>
      insertAccount(org.orgId, "2650", "liability_current_other"),
    );
    const loan = await withBypassContext(() =>
      insertAccount(org.orgId, "2700", "liability_long_term", { reconcilable: false }),
    );
    const payable = await withBypassContext(() =>
      insertAccount(org.orgId, "9250", "liability_payable", { reconcilable: false }),
    );

    const transferIds = (await withBypassContext(() => transferAccountOptions(org.orgId))).map(
      (option) => option.id,
    );
    assert.ok(transferIds.includes(creditLine), "a reconcilable credit line is a transfer leg");
    assert.ok(!transferIds.includes(loan), "a non-reconcilable loan is not a Banking account");
    assert.ok(
      !transferIds.includes(payable),
      "a non-reconcilable payable is not a Banking account",
    );

    const reconcilableIds = (
      await withBypassContext(() => listReconcilableBankAccounts(org.orgId))
    ).map((account) => account.id);
    assert.ok(
      reconcilableIds.includes(creditLine),
      "statement import and reconciliation offer the credit line",
    );
    assert.ok(!reconcilableIds.includes(loan));
    assert.ok(!reconcilableIds.includes(payable));
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("transfer legs list bank and credit-card accounts, and nothing else", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const bank = await withBypassContext(() => insertAccount(org.orgId, "9100", "asset_bank"));
    const unreconciledBank = await withBypassContext(() =>
      insertAccount(org.orgId, "9101", "asset_bank", { reconcilable: false }),
    );
    const card = await withBypassContext(() => insertAccount(org.orgId, "9200", "liability_card"));
    const inactiveCard = await withBypassContext(() =>
      insertAccount(org.orgId, "9201", "liability_card", { isActive: false }),
    );
    const summaryBank = await withBypassContext(() =>
      insertAccount(org.orgId, "9102", "asset_bank", { isSummary: true }),
    );
    const income = await withBypassContext(() => insertAccount(org.orgId, "4900", "income"));

    const transferIds = (await withBypassContext(() => transferAccountOptions(org.orgId))).map(
      (option) => option.id,
    );
    assert.ok(transferIds.includes(bank), "reconcilable bank accounts are transfer legs");
    assert.ok(
      transferIds.includes(unreconciledBank),
      "banking-managed bank accounts need not be reconcilable",
    );
    assert.ok(transferIds.includes(card), "a credit-card account can be the destination or source");
    assert.ok(!transferIds.includes(inactiveCard), "inactive cards are not offered");
    assert.ok(!transferIds.includes(summaryBank), "summary accounts cannot be posted to");
    assert.ok(!transferIds.includes(income), "non-banking accounts are not transfer legs");

    const fundingIds = (await withBypassContext(() => bankAccountOptions(org.orgId))).map(
      (option) => option.id,
    );
    assert.ok(fundingIds.includes(bank));
    assert.ok(!fundingIds.includes(card), "deposit and check funding stays bank-only");
    assert.ok(
      !fundingIds.includes(unreconciledBank),
      "deposit and check funding stays reconcilable-only",
    );
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

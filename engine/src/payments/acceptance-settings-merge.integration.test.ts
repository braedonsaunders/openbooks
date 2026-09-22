import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  type AcceptanceProvider,
  configSecrets,
  resolveAcceptanceProviderApiBase,
  saveAcceptanceConfig,
} from "./acceptance.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  createScratchUser,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

const LIVE_BASE = "https://acme-checkout-live.adyenpayments.com/checkout/v68";

async function readSettings(orgId: string, provider: string) {
  const rows = (await db.execute<{ settings: Record<string, unknown> }>(sql`
    select settings from psp_provider_configs
     where org_id = ${orgId} and provider = ${provider}
  `)).rows;
  return rows[0]!.settings as Record<string, unknown>;
}

async function readConfigRow(orgId: string, provider: string) {
  const rows = (await db.execute<{
    id: string; provider: AcceptanceProvider; display_name: string; is_enabled: boolean;
    acceptance_enabled: boolean; default_bank_account_id: string | null;
    publishable_key: string | null; settings: Record<string, unknown>;
    surcharge_rule_id: string | null; secrets: string | null;
  }>(sql`
    select id, provider, display_name, is_enabled, acceptance_enabled,
           default_bank_account_id, publishable_key, settings,
           surcharge_rule_id, secrets
      from psp_provider_configs
     where org_id = ${orgId} and provider = ${provider}
  `)).rows;
  return rows[0]!;
}

// Saving through the exact payload shape PaymentProvidersClient posts for
// Adyen must keep a previously configured live endpoint: the UI has no
// apiBase field, so omission has to mean "keep", never "revert to test".
test("UI-shaped Adyen save preserves a stored live apiBase", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const userId = await createScratchUser(org.orgId, "Pay Audit", "admin");
    await saveAcceptanceConfig(org.orgId, userId, {
      provider: "adyen",
      isEnabled: true,
      acceptanceEnabled: true,
      defaultBankAccountId: null,
      surchargeRuleId: null,
      settings: { merchantAccount: "AcmeLive", apiBase: LIVE_BASE, note: "keep-me" },
    });
    // Exactly what PaymentProvidersClient posts on Save for Adyen.
    await saveAcceptanceConfig(org.orgId, userId, {
      provider: "adyen",
      isEnabled: true,
      acceptanceEnabled: true,
      defaultBankAccountId: null,
      publishableKey: null,
      surchargeRuleId: null,
      settings: { merchantAccount: "AcmeLiveRenamed" },
    });
    const after = await readSettings(org.orgId, "adyen");
    assert.equal(after.apiBase, LIVE_BASE);
    assert.equal(after.merchantAccount, "AcmeLiveRenamed");
    assert.equal(after.note, "keep-me");
    // The live endpoint must still resolve for checkout, not the test host.
    assert.equal(
      configSecrets(await readConfigRow(org.orgId, "adyen")).apiBase,
      LIVE_BASE,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("explicit valid apiBase change applies", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const userId = await createScratchUser(org.orgId, "Pay Audit", "admin");
    await saveAcceptanceConfig(org.orgId, userId, {
      provider: "adyen",
      isEnabled: true,
      acceptanceEnabled: true,
      defaultBankAccountId: null,
      surchargeRuleId: null,
      settings: { merchantAccount: "AcmeLive", apiBase: LIVE_BASE },
    });
    const next = "https://acme-checkout-live.adyenpayments.com/checkout/v71";
    await saveAcceptanceConfig(org.orgId, userId, {
      provider: "adyen",
      isEnabled: true,
      acceptanceEnabled: true,
      defaultBankAccountId: null,
      surchargeRuleId: null,
      settings: { apiBase: next },
    });
    const after = await readSettings(org.orgId, "adyen");
    assert.equal(after.apiBase, next);
    assert.equal(after.merchantAccount, "AcmeLive");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("invalid apiBase refuses by provider name with storage unchanged", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const userId = await createScratchUser(org.orgId, "Pay Audit", "admin");
    await saveAcceptanceConfig(org.orgId, userId, {
      provider: "adyen",
      isEnabled: true,
      acceptanceEnabled: true,
      defaultBankAccountId: null,
      surchargeRuleId: null,
      settings: { merchantAccount: "AcmeLive", apiBase: LIVE_BASE },
    });
    await assert.rejects(
      saveAcceptanceConfig(org.orgId, userId, {
        provider: "adyen",
        isEnabled: true,
        acceptanceEnabled: true,
        defaultBankAccountId: null,
        surchargeRuleId: null,
        settings: { merchantAccount: "AcmeLive", apiBase: "https://evil.example.com/v1" },
      }),
      (e: unknown) =>
        e instanceof Error &&
        e.message.includes("adyen") &&
        e.message.includes("allowlisted"),
    );
    // An explicit null is not a clear: the canonical normalizer refuses it.
    await assert.rejects(
      saveAcceptanceConfig(org.orgId, userId, {
        provider: "adyen",
        isEnabled: true,
        acceptanceEnabled: true,
        defaultBankAccountId: null,
        surchargeRuleId: null,
        settings: { apiBase: null },
      }),
      (e: unknown) =>
        e instanceof Error &&
        e.message.includes("adyen") &&
        e.message.includes("allowlisted"),
    );
    const after = await readSettings(org.orgId, "adyen");
    assert.equal(after.apiBase, LIVE_BASE);
    assert.equal(after.merchantAccount, "AcmeLive");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("revert path is an explicit allowlisted default endpoint", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const userId = await createScratchUser(org.orgId, "Pay Audit", "admin");
    await saveAcceptanceConfig(org.orgId, userId, {
      provider: "adyen",
      isEnabled: true,
      acceptanceEnabled: true,
      defaultBankAccountId: null,
      surchargeRuleId: null,
      settings: { merchantAccount: "AcmeLive", apiBase: LIVE_BASE },
    });
    const revert = resolveAcceptanceProviderApiBase("adyen", undefined);
    await saveAcceptanceConfig(org.orgId, userId, {
      provider: "adyen",
      isEnabled: true,
      acceptanceEnabled: true,
      defaultBankAccountId: null,
      surchargeRuleId: null,
      settings: { apiBase: revert },
    });
    const after = await readSettings(org.orgId, "adyen");
    assert.equal(after.apiBase, revert);
    assert.equal(after.merchantAccount, "AcmeLive");
    assert.equal(
      configSecrets(await readConfigRow(org.orgId, "adyen")).apiBase,
      revert,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("overlapping apiBase edit and UI-shaped save retain both explicit changes", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const userId = await createScratchUser(org.orgId, "Pay Audit", "admin");
    const base = { isEnabled: true, acceptanceEnabled: true, defaultBankAccountId: null, surchargeRuleId: null } as const;
    await saveAcceptanceConfig(org.orgId, userId, {
      ...base,
      provider: "adyen",
      settings: { merchantAccount: "Acme", apiBase: LIVE_BASE },
    });
    const next = "https://acme-checkout-live.adyenpayments.com/checkout/v71";
    // An endpoint edit racing a sanctioned UI save: without serialization both
    // merge the same stale settings and the loser’s explicit change vanishes.
    await Promise.all([
      saveAcceptanceConfig(org.orgId, userId, {
        ...base,
        provider: "adyen",
        settings: { apiBase: next },
      }),
      saveAcceptanceConfig(org.orgId, userId, {
        ...base,
        provider: "adyen",
        publishableKey: null,
        settings: { merchantAccount: "AcmeNew" },
      }),
    ]);
    const after = await readSettings(org.orgId, "adyen");
    assert.equal(after.apiBase, next);
    assert.equal(after.merchantAccount, "AcmeNew");
    // Audit rows must chain: the second writer's "before" is the first
    // writer's "after", never the same stale snapshot twice.
    const audits = (await db.execute<{ changes: { before: { settings: Record<string, unknown> } | null; after: { settings: Record<string, unknown> } } }>(sql`
      select changes from audit_log
       where org_id = ${org.orgId} and table_name = 'psp_provider_configs' and action = 'update'
       order by id
    `)).rows;
    assert.equal(audits.length, 2);
    assert.deepEqual(audits[1]!.changes.before!.settings, audits[0]!.changes.after.settings);
    assert.equal(audits[1]!.changes.after.settings.apiBase, next);
    assert.equal(audits[1]!.changes.after.settings.merchantAccount, "AcmeNew");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("Adyen settings save is isolated from the stripe row", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const userId = await createScratchUser(org.orgId, "Pay Audit", "admin");
    await saveAcceptanceConfig(org.orgId, userId, {
      provider: "stripe",
      isEnabled: true,
      acceptanceEnabled: true,
      defaultBankAccountId: null,
      surchargeRuleId: null,
      settings: {},
    });
    await saveAcceptanceConfig(org.orgId, userId, {
      provider: "adyen",
      isEnabled: true,
      acceptanceEnabled: true,
      defaultBankAccountId: null,
      surchargeRuleId: null,
      settings: { merchantAccount: "AcmeLive", apiBase: LIVE_BASE },
    });
    await saveAcceptanceConfig(org.orgId, userId, {
      provider: "adyen",
      isEnabled: true,
      acceptanceEnabled: true,
      defaultBankAccountId: null,
      publishableKey: null,
      surchargeRuleId: null,
      settings: { merchantAccount: "AcmeLive" },
    });
    assert.equal((await readSettings(org.orgId, "adyen")).apiBase, LIVE_BASE);
    assert.deepEqual(await readSettings(org.orgId, "stripe"), {});
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

/** Operator-facing acceptance provider configuration: connection checks
 *  and governed saves of the provider config row. */
import { assertUnrestrictedScope } from "../organization/subsidiary-scope.ts";
import { PROCESSOR_RECEIPT_POLICY_KEY } from "../payments-core/receipt-funding.ts";
import { canonicalJson } from "../platform/canonical-json.ts";
import { db } from "../platform/db.ts";
import { sealJson, unsealJson } from "../platform/secrets.ts";
import {
  defaultFetch,
  fetchJsonBody,
  jsonObject,
  normalizeAcceptanceProviderSettings,
  resolveAcceptanceProviderApiBase,
} from "./acceptance-provider-utils.ts";
import {
  validateAcceptanceBankAccount,
  validateConfiguredSurchargeRule,
} from "./acceptance-surcharge.ts";
import {
  type AcceptanceProvider,
  type FetchFn,
  PaymentAcceptanceError,
  type ProviderConfigRow,
  type ProviderSecrets,
} from "./acceptance-types.ts";
import { loadPaymentProviderConfig } from "./payment-link-session-expiry.ts";
import { validateSettlementPostingAccounts } from "./psp-settlement-posting-context.ts";
import { sql } from "drizzle-orm";

/** Lightweight credential check against the provider's API (no side effects). */
export async function testAcceptanceConnection(
  provider: AcceptanceProvider,
  secrets: ProviderSecrets,
  fetchFn: FetchFn = defaultFetch,
): Promise<{ ok: boolean; detail: string }> {
  try {
    if (provider === "stripe") {
      if (!secrets.apiKey) return { ok: false, detail: "no API key configured" };
      const base = resolveAcceptanceProviderApiBase("stripe", secrets.apiBase);
      const res = await fetchFn(`${base}/v1/account`, {
        method: "GET",
        redirect: "error",
        headers: {
          authorization: `Basic ${Buffer.from(`${secrets.apiKey}:`).toString("base64")}`,
        },
      });
      const json = await fetchJsonBody(res);
      const profileName = jsonObject(json.business_profile).name;
      const errorMessage = jsonObject(json.error).message;
      return res.status < 400
        ? {
            ok: true,
            detail: `connected${profileName ? ` — ${profileName}` : ""}`,
          }
        : {
            ok: false,
            detail: typeof errorMessage === "string" ? errorMessage : `HTTP ${res.status}`,
          };
    }
    if (provider === "adyen") {
      if (!secrets.apiKey || !secrets.merchantAccount)
        return {
          ok: false,
          detail: "API key and merchant account are required",
        };
      const base = resolveAcceptanceProviderApiBase("adyen", secrets.apiBase);
      const res = await fetchFn(`${base}/paymentMethods`, {
        method: "POST",
        redirect: "error",
        headers: {
          "x-api-key": secrets.apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({ merchantAccount: secrets.merchantAccount }),
      });
      const json = await fetchJsonBody(res);
      return res.status < 400
        ? {
            ok: true,
            detail: `connected — ${Array.isArray(json.paymentMethods) ? json.paymentMethods.length : 0} payment methods`,
          }
        : {
            ok: false,
            detail: typeof json.message === "string" ? json.message : `HTTP ${res.status}`,
          };
    }
    // gocardless
    if (!secrets.apiKey) return { ok: false, detail: "no access token configured" };
    const base = resolveAcceptanceProviderApiBase("gocardless", secrets.apiBase);
    const res = await fetchFn(`${base}/billing_requests?limit=1`, {
      method: "GET",
      redirect: "error",
      headers: {
        authorization: `Bearer ${secrets.apiKey}`,
        "GoCardless-Version": "2015-07-06",
      },
    });
    return res.status < 400
      ? { ok: true, detail: "connected" }
      : { ok: false, detail: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

export async function saveAcceptanceConfig(
  orgId: string,
  actorId: string,
  input: {
    provider: AcceptanceProvider;
    displayName?: string;
    isEnabled: boolean;
    acceptanceEnabled: boolean;
    defaultBankAccountId?: string | null;
    publishableKey?: string | null;
    surchargeRuleId?: string | null;
    settings?: Record<string, unknown>;
    apiKey?: string | null;
    webhookSecret?: string | null;
    defaultDisputedFundsAccountId?: string | null;
    defaultChargebackLossAccountId?: string | null;
    defaultDisputeFeeAccountId?: string | null;
  },
  /**
   * REQUIRED actor scope (explicit null only for system/test setup): provider
   * configs are org-wide rows with no subsidiary lineage, so the write
   * requires unrestricted scope — a restricted caller is refused by name
   * before any validation or persistence.
   */
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<void> {
  assertUnrestrictedScope(allowedSubsidiaryIds);
  if (input.defaultBankAccountId !== undefined && input.defaultBankAccountId !== null) {
    await validateAcceptanceBankAccount(orgId, input.defaultBankAccountId);
  }
  await validateConfiguredSurchargeRule(orgId, input.provider, input.surchargeRuleId ?? null);

  // Dispute accounts post the automated refund/dispute journals: a foreign or
  // unpostable reference must fail the save, not the first chargeback. The
  // settlement validator raises the settlement domain error; reframe it as an
  // acceptance error so setup callers keep one 422 contract.
  try {
    await validateSettlementPostingAccounts(orgId, [
      { label: "disputed-funds", id: input.defaultDisputedFundsAccountId },
      { label: "chargeback-loss", id: input.defaultChargebackLossAccountId },
      { label: "dispute-fee", id: input.defaultDisputeFeeAccountId },
    ]);
  } catch (e) {
    throw new PaymentAcceptanceError(e instanceof Error ? e.message : String(e));
  }
  await db.transaction(async (tx) => {
    // Settings share the provider row with dated receipt funding policies.
    // Serialize their read/merge/write so neither native editor loses policy.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`processor-receipt-policy:${orgId}`}, 0))`,
    );
    // Serialize creates and saves for this org/provider before reading, so
    // overlapping merges cannot drop each other's explicit changes.
    await tx.execute(sql`
      select pg_advisory_xact_lock(hashtextextended(${`payment-acceptance-config:${orgId}:${input.provider}`}, 0))
    `);
    type ConfigRow = ProviderConfigRow;
    // Snapshot the stored config first so the audit row carries the real
    // before/after state; sealed secrets appear only as presence flags.
    const existing = await loadPaymentProviderConfig<ProviderConfigRow>(orgId, input.provider, tx);
    // Omitted keys survive UI saves (the setup form posts only the fields it
    // renders); supplied values overwrite, and the merged result passes the
    // canonical endpoint normalizer.
    const mergedSettings = { ...(existing?.settings ?? {}) };
    for (const [key, value] of Object.entries(input.settings ?? {})) {
      if (
        key === PROCESSOR_RECEIPT_POLICY_KEY &&
        canonicalJson(value) !== canonicalJson(existing?.settings?.[key] ?? [])
      ) {
        throw new PaymentAcceptanceError(
          "Use the native processor receipt funding command with a reason to change receipt policy.",
        );
      }
      mergedSettings[key] = value;
    }
    const settings = normalizeAcceptanceProviderSettings(input.provider, mergedSettings);
    const configView = (row: ConfigRow | null) =>
      row === null
        ? null
        : {
            displayName: row.display_name,
            isEnabled: row.is_enabled,
            acceptanceEnabled: row.acceptance_enabled,
            defaultBankAccountId: row.default_bank_account_id,
            publishableKey: row.publishable_key ?? null,
            surchargeRuleId: row.surcharge_rule_id,
            defaultDisputedFundsAccountId: row.default_disputed_funds_account_id ?? null,
            defaultChargebackLossAccountId: row.default_chargeback_loss_account_id ?? null,
            defaultDisputeFeeAccountId: row.default_dispute_fee_account_id ?? null,
            settings: row.settings,
            hasApiKey:
              row.secrets != null &&
              !!unsealJson<{ apiKey?: string }>(row.secrets, {
                orgId,
                purpose: "payment.provider.secrets",
              }).apiKey,
            hasWebhookSecret:
              row.secrets != null &&
              !!unsealJson<{ webhookSecret?: string }>(row.secrets, {
                orgId,
                purpose: "payment.provider.secrets",
              }).webhookSecret,
          };
    let secrets: string | null = null;
    if (input.apiKey || input.webhookSecret) {
      // Merge with any existing sealed secrets so one field can rotate alone.
      const prior =
        existing?.secrets == null
          ? {}
          : unsealJson<{ apiKey?: string; webhookSecret?: string }>(existing.secrets, {
              orgId,
              purpose: "payment.provider.secrets",
            });
      secrets = await sealJson(
        {
          ...prior,
          apiKey: input.apiKey ?? prior.apiKey,
          webhookSecret: input.webhookSecret ?? prior.webhookSecret,
        },
        { orgId, purpose: "payment.provider.secrets" },
      );
    }
    const savedRows = await tx.execute<ConfigRow>(
      sql`
      insert into psp_provider_configs
        (org_id, provider, display_name, is_enabled, acceptance_enabled, default_bank_account_id,
         publishable_key, surcharge_rule_id, settings, secrets,
         default_disputed_funds_account_id, default_chargeback_loss_account_id,
         default_dispute_fee_account_id, created_by, updated_by)
      values (${orgId}, ${input.provider}, ${input.displayName ?? input.provider}, ${input.isEnabled},
              ${input.acceptanceEnabled}, ${input.defaultBankAccountId ?? null},
              ${input.publishableKey ?? null}, ${input.surchargeRuleId ?? null},
              ${JSON.stringify(settings)}::jsonb, ${secrets},
              ${input.defaultDisputedFundsAccountId ?? null}::uuid,
              ${input.defaultChargebackLossAccountId ?? null}::uuid,
              ${input.defaultDisputeFeeAccountId ?? null}::uuid,
              ${actorId}, ${actorId})
      on conflict (org_id, provider) do update set
        display_name = excluded.display_name,
        is_enabled = excluded.is_enabled,
        acceptance_enabled = excluded.acceptance_enabled,
        default_bank_account_id = excluded.default_bank_account_id,
        publishable_key = excluded.publishable_key,
        surcharge_rule_id = excluded.surcharge_rule_id,
        settings = excluded.settings,
        secrets = coalesce(excluded.secrets, psp_provider_configs.secrets),
        -- The setup form renders the automation policy and dispute accounts,
        -- so a save that names them owns them (explicit null clears a
        -- mapping); a save that omits them (older callers) keeps the stored
        -- values instead of silently resetting review back to automatic.

        default_disputed_funds_account_id = case when ${input.defaultDisputedFundsAccountId === undefined}
          then psp_provider_configs.default_disputed_funds_account_id
          else ${input.defaultDisputedFundsAccountId ?? null}::uuid end,
        default_chargeback_loss_account_id = case when ${input.defaultChargebackLossAccountId === undefined}
          then psp_provider_configs.default_chargeback_loss_account_id
          else ${input.defaultChargebackLossAccountId ?? null}::uuid end,
        default_dispute_fee_account_id = case when ${input.defaultDisputeFeeAccountId === undefined}
          then psp_provider_configs.default_dispute_fee_account_id
          else ${input.defaultDisputeFeeAccountId ?? null}::uuid end,
        updated_at = now(), updated_by = ${actorId}
      where psp_provider_configs.org_id = ${orgId}
      returning id, provider, display_name, is_enabled, acceptance_enabled, default_bank_account_id,
                publishable_key, surcharge_rule_id, settings, secrets,
                default_disputed_funds_account_id, default_chargeback_loss_account_id,
                default_dispute_fee_account_id
    `,
      "objects",
    );
    const saved = savedRows[0];
    if (!saved) throw new PaymentAcceptanceError("provider config failed to persist");
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'psp_provider_configs', ${saved.id},
              ${existing ? "update" : "insert"},
              ${JSON.stringify({ before: configView(existing), after: configView(saved) })}::jsonb,
              ${actorId})
    `);
  });
}

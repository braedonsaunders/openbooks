import "server-only";

import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import type { Authz } from "../authz";
import { isFeatureEnabled } from "../features";
import type { PaymentProviderAccount, PaymentProviderSetupData } from "./payment-providers-types";

type PaymentProviderAccountRow = PaymentProviderAccount & Record<string, unknown>;

/**
 * Shared authorized reader for the payment provider page and its API. Callers
 * establish the organization transaction before invoking it; subsidiary
 * account references are masked to the same scope used by their pickers.
 */
export async function readPaymentProviderSetupData(
  authz: Authz,
): Promise<PaymentProviderSetupData> {
  const orgId = authz.user.orgId;
  const scope = authz.allowedSubsidiaryIds;
  const accountScope =
    scope === null
      ? sql``
      : sql` and (subsidiary_id is null or subsidiary_id = any(${`{${[...scope].join(",")}}`}::uuid[]))`;
  const [configs, automationConfigs, banks, rules, incomeAccounts, postingAccounts] =
    await Promise.all([
      db.execute(
        sql`
      select provider, display_name as "displayName", is_enabled as "isEnabled",
             acceptance_enabled as "acceptanceEnabled", default_bank_account_id as "defaultBankAccountId",
             publishable_key as "publishableKey", surcharge_rule_id as "surchargeRuleId", settings,
             (secrets is not null) as "hasSecrets", last_error as "lastError",
             default_disputed_funds_account_id as "defaultDisputedFundsAccountId",
             default_chargeback_loss_account_id as "defaultChargebackLossAccountId",
             default_dispute_fee_account_id as "defaultDisputeFeeAccountId"
        from psp_provider_configs
       where org_id = ${orgId} and provider in ('stripe', 'adyen', 'gocardless')
       order by provider
    `,
        "objects",
      ),
      db.execute(
        sql`
      select provider, display_name as "displayName", is_enabled as "isEnabled", pull_enabled as "pullEnabled",
             default_disputed_funds_account_id as "defaultDisputedFundsAccountId",
             default_chargeback_loss_account_id as "defaultChargebackLossAccountId",
             default_dispute_fee_account_id as "defaultDisputeFeeAccountId"
        from psp_provider_configs
       where org_id = ${orgId} and provider in ('paypal', 'shopify_payments', 'square')
       order by provider
    `,
        "objects",
      ),
      db.execute<PaymentProviderAccountRow>(
        sql`
      select id, number, name from accounts
       where org_id = ${orgId} and type = 'asset_bank' and is_active and not is_summary
       ${accountScope}
       order by number nulls last, name
    `,
        "objects",
      ),
      db.execute(
        sql`
      select id, name, calculation, percent::text as percent,
             fixed_amount::text as "fixedAmount", cap_amount::text as "capAmount",
             fee_income_account_id as "feeIncomeAccountId", provider,
             payment_method as "paymentMethod", effective_from::text as "effectiveFrom",
             effective_to::text as "effectiveTo", is_active as "isActive"
        from payment_surcharge_rules where org_id = ${orgId}
       order by effective_from desc
    `,
        "objects",
      ),
      db.execute<PaymentProviderAccountRow>(
        sql`
      select id, number, name from accounts
       where org_id = ${orgId} and type in ('income', 'income_other') and is_active and not is_summary
       ${accountScope}
       order by number nulls last, name
    `,
        "objects",
      ),
      db.execute<PaymentProviderAccountRow>(
        sql`
      select id, number, name from accounts
       where org_id = ${orgId} and is_active and not is_summary
       ${accountScope}
       order by number nulls last, name
    `,
        "objects",
      ),
    ]);

  const disputeAccountKeys = [
    "defaultDisputedFundsAccountId",
    "defaultChargebackLossAccountId",
    "defaultDisputeFeeAccountId",
  ] as const;
  let configRows = configs as Array<Record<string, unknown>>;
  let automationRows = automationConfigs as Array<Record<string, unknown>>;
  let surchargeRows = rules as Array<Record<string, unknown>>;
  if (scope !== null) {
    configRows = configRows.map((row) => {
      const settings = { ...((row.settings as Record<string, unknown>) ?? {}) };
      delete settings.processorReceiptPolicies;
      return { ...row, settings };
    });
    const referenced = [
      ...new Set(
        [
          ...configRows.map((config) => config.defaultBankAccountId),
          ...configRows.flatMap((config) => disputeAccountKeys.map((key) => config[key])),
          ...automationRows.flatMap((config) => disputeAccountKeys.map((key) => config[key])),
          ...surchargeRows.map((rule) => rule.feeIncomeAccountId),
        ].filter((id): id is string => typeof id === "string"),
      ),
    ];
    if (referenced.length > 0) {
      const accounts = await db.execute<{
        id: string;
        subsidiary_id: string | null;
      }>(
        sql`
        select id, subsidiary_id from accounts
         where org_id = ${orgId} and id = any(${`{${referenced.join(",")}}`}::uuid[])
      `,
        "objects",
      );
      const visible = new Set(
        accounts
          .filter((row) => row.subsidiary_id === null || scope.has(row.subsidiary_id))
          .map((row) => row.id),
      );
      const maskDisputeAccounts = (row: Record<string, unknown>) => {
        let masked = row;
        for (const key of disputeAccountKeys) {
          if (typeof masked[key] === "string" && !visible.has(masked[key] as string)) {
            masked = { ...masked, [key]: null };
          }
        }
        return masked;
      };
      configRows = configRows.map((config) => {
        const masked = maskDisputeAccounts(config);
        return typeof config.defaultBankAccountId === "string" &&
          !visible.has(config.defaultBankAccountId)
          ? { ...masked, defaultBankAccountId: null }
          : masked;
      });
      automationRows = automationRows.map(maskDisputeAccounts);
      surchargeRows = surchargeRows.map((rule) =>
        typeof rule.feeIncomeAccountId === "string" && !visible.has(rule.feeIncomeAccountId)
          ? { ...rule, feeIncomeAccountId: null }
          : rule,
      );
    }
  }

  return {
    configs: configRows as unknown as PaymentProviderSetupData["configs"],
    automationConfigs: automationRows as unknown as PaymentProviderSetupData["automationConfigs"],
    bankAccounts: banks as PaymentProviderSetupData["bankAccounts"],
    surchargeRules: surchargeRows as unknown as PaymentProviderSetupData["surchargeRules"],
    incomeAccounts: incomeAccounts as PaymentProviderSetupData["incomeAccounts"],
    postingAccounts: postingAccounts as PaymentProviderSetupData["postingAccounts"],
    featureEnabled: await isFeatureEnabled(orgId, "onlinePayments"),
    bankingEnabled: await isFeatureEnabled(orgId, "banking"),
  };
}

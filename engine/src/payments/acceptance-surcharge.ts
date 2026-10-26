/** Acceptance surcharge policy resolution and provider-configuration
 *  reference validation. */
import { add, cmp, fromUnits, mulPercent, roundDiv, toUnits } from "../money/money.ts";
import { db } from "../platform/db.ts";
import { unsealJson } from "../platform/secrets.ts";
import { isUuid } from "../platform/uuid.ts";
import { normalizeAcceptanceProviderSettings } from "./acceptance-provider-utils.ts";
import {
  type AcceptanceProvider,
  PaymentAcceptanceError,
  type ProviderConfigRow,
  type ProviderSecrets,
  type SurchargeResolution,
} from "./acceptance-types.ts";
import { THREE_DECIMAL_CURRENCIES, ZERO_DECIMAL_CURRENCIES } from "./minor-units.ts";
import { sql } from "drizzle-orm";

export function configSecrets(config: ProviderConfigRow, orgId: string): ProviderSecrets {
  const sealed =
    config.secrets == null
      ? null
      : unsealJson<{ apiKey?: string; webhookSecret?: string }>(config.secrets, {
          orgId,
          purpose: "payment.provider.secrets",
        });
  const settings = normalizeAcceptanceProviderSettings(config.provider, config.settings ?? {});
  return {
    apiKey: sealed?.apiKey,
    webhookSecret: sealed?.webhookSecret,
    publishableKey: config.publishable_key ?? undefined,
    merchantAccount:
      typeof settings.merchantAccount === "string" ? settings.merchantAccount : undefined,
    apiBase: typeof settings.apiBase === "string" ? settings.apiBase : undefined,
    recurringApiBase:
      typeof settings.recurringApiBase === "string" ? settings.recurringApiBase : undefined,
  };
}

export function assertAcceptanceUuid(value: string, label: string): void {
  if (!isUuid(value)) {
    throw new PaymentAcceptanceError(`${label} must be a valid UUID`);
  }
}

/** Validate a receipt bank reference at the service boundary. The migration
 *  also enforces this invariant for direct SQL writers; keeping the check here
 *  makes stale/deactivated accounts fail before any payment-side effect. */
export async function validateAcceptanceBankAccount(
  orgId: string,
  accountId: string,
): Promise<void> {
  assertAcceptanceUuid(accountId, "bank account");
  const row = await db.execute<{ id: string }>(
    sql`
    select id
      from accounts
     where org_id = ${orgId} and id = ${accountId}
       and type = 'asset_bank' and is_active and not is_summary
     limit 1
  `,
    "objects",
  );
  if (!row[0]) {
    throw new PaymentAcceptanceError("bank account must be an active bank-type account");
  }
}

/** Surcharge income is deliberately narrower than a generic posting account. */
export async function validateSurchargeIncomeAccount(
  orgId: string,
  accountId: string,
): Promise<void> {
  assertAcceptanceUuid(accountId, "surcharge income account");
  const row = await db.execute<{ id: string }>(
    sql`
    select id
      from accounts
     where org_id = ${orgId} and id = ${accountId}
       and type in ('income', 'income_other') and is_active and not is_summary
     limit 1
  `,
    "objects",
  );
  if (!row[0]) {
    throw new PaymentAcceptanceError("surcharge income account must be an active income account");
  }
}

/** A configured rule is an explicit reference, not merely a preference. An
 *  inactive, foreign, provider-incompatible, method-incompatible, or
 *  out-of-window rule must never be silently replaced by a fallback rule
 *  during link creation or checkout: the quote refuses by name instead.
 *
 *  Effective dates are runtime state, not stable configuration — the quote's
 *  business date is canonical — so callers that persist configuration
 *  (saveAcceptanceConfig) validate without `onDate` and must never refuse a
 *  rule merely for being future-dated. Quote paths always pass the business
 *  date they price on. */
export async function validateConfiguredSurchargeRule(
  orgId: string,
  provider: AcceptanceProvider,
  ruleId: string | null,
  options: { onDate?: string } = {},
): Promise<void> {
  if (ruleId === null) return;
  assertAcceptanceUuid(ruleId, "surcharge rule");
  const row = await db.execute<{
    id: string;
    name: string;
    is_active: boolean;
    provider: AcceptanceProvider | null;
    payment_method: string;
    effective_from: string;
    effective_to: string | null;
    fee_income_account_id: string;
  }>(
    sql`
    select id, name, is_active, provider, payment_method,
           effective_from::text as effective_from, effective_to::text as effective_to,
           fee_income_account_id
      from payment_surcharge_rules
     where org_id = ${orgId} and id = ${ruleId}
     limit 1
  `,
    "objects",
  );
  const rule = row[0];
  if (!rule) {
    throw new PaymentAcceptanceError(
      `surcharge rule ${ruleId} was not found in this organization; ` +
        "choose an active surcharge rule in Company Settings → Payment Providers",
    );
  }
  if (!rule.is_active) {
    throw new PaymentAcceptanceError(
      `surcharge rule "${rule.name}" is not active; ` +
        "choose an active surcharge rule in Company Settings → Payment Providers",
    );
  }
  if (rule.provider !== null && rule.provider !== provider) {
    throw new PaymentAcceptanceError(
      `surcharge rule "${rule.name}" is configured for ${rule.provider}, not ${provider}; ` +
        "choose a matching surcharge rule in Company Settings → Payment Providers",
    );
  }
  const method = providerPaymentMethod(provider);
  if (rule.payment_method !== "all" && rule.payment_method !== method) {
    throw new PaymentAcceptanceError(
      `surcharge rule "${rule.name}" prices ${rule.payment_method} payments, not ${method} ${provider} checkout; ` +
        "choose a matching surcharge rule in Company Settings → Payment Providers",
    );
  }
  // Same window predicate the resolution query applies (effective_from <=
  // onDate, open-ended or effective_to >= onDate): ISO dates compare
  // lexicographically, so the TypeScript check below cannot drift from it.
  if (options.onDate !== undefined) {
    const window =
      rule.effective_to === null
        ? `${rule.effective_from} onwards`
        : `${rule.effective_from} to ${rule.effective_to}`;
    if (
      options.onDate < rule.effective_from ||
      (rule.effective_to !== null && options.onDate > rule.effective_to)
    ) {
      throw new PaymentAcceptanceError(
        `surcharge rule "${rule.name}" is not in effect on ${options.onDate} (effective ${window}); ` +
          "choose a surcharge rule in effect for the quote date in Company Settings → Payment Providers",
      );
    }
  }
  await validateSurchargeIncomeAccount(orgId, rule.fee_income_account_id);
}

export async function validateProviderConfigReferences(
  orgId: string,
  config: ProviderConfigRow,
  options: { validateSurchargeRule?: boolean } = {},
): Promise<void> {
  if (config.default_bank_account_id !== null) {
    await validateAcceptanceBankAccount(orgId, config.default_bank_account_id);
  }
  if (options.validateSurchargeRule !== false) {
    await validateConfiguredSurchargeRule(orgId, config.provider, config.surcharge_rule_id);
  }
}

/** Pure surcharge math: percent / fixed / percent+fixed, optional cap. */
export function computeSurcharge(
  baseAmount: string,
  rule: {
    calculation: string;
    percent: string | null;
    fixed_amount: string | null;
    cap_amount: string | null;
  },
): string {
  let fee = "0";
  if (rule.calculation === "percent" || rule.calculation === "percent_plus_fixed") {
    fee = add(fee, mulPercent(baseAmount, rule.percent ?? "0", 4));
  }
  if (rule.calculation === "fixed" || rule.calculation === "percent_plus_fixed") {
    fee = add(fee, rule.fixed_amount ?? "0");
  }
  if (rule.cap_amount && cmp(fee, rule.cap_amount) > 0) fee = rule.cap_amount;
  return fee;
}

/** The payment method each acceptance provider's hosted checkout collects:
 *  Stripe and Adyen sessions present cards; GoCardless collects bank debits
 *  (ACH/SEPA). Surcharge rules carry this dimension, so resolution must match
 *  it — a card-only fee must never land on a bank debit and vice versa. */
export function providerPaymentMethod(provider: AcceptanceProvider): "card" | "bank_debit" {
  return provider === "gocardless" ? "bank_debit" : "card";
}

/** Effective-dated surcharge resolution for one checkout. Candidates are the
 *  org's active rules covering `onDate` whose provider and payment-method
 *  dimensions match (method-scoped rules never leak across card vs bank
 *  debit, not even when they are the provider-configured rule). Precedence is
 *  deterministic: the provider-configured rule first, then provider-specific,
 *  then global — each tier newest-effective first, id breaking any remaining
 *  tie. */
/**
 * Provider minor-unit quantization for quoted fees. Provider boundaries only
 * accept whole minor units, so a computed fee with sub-minor dust (3% of
 * $11.11 is $0.3333) must be rounded here at quote time — every adapter
 * refuses it later, failing the whole checkout. Halves away from zero,
 * matching the ledger's rounding; zero-decimal currencies quantize to whole
 * units, three-decimal ones to millis.
 */
export function quantizeSurchargeToMinorUnits(amount: string, currency: string): string {
  const units = toUnits(amount);
  const code = currency.toUpperCase();
  const divisor = ZERO_DECIMAL_CURRENCIES.has(code)
    ? 10_000n
    : THREE_DECIMAL_CURRENCIES.has(code)
      ? 10n
      : 100n;
  return fromUnits(roundDiv(units, divisor) * divisor);
}

export async function resolveSurcharge(
  orgId: string,
  opts: {
    provider: AcceptanceProvider;
    amount: string;
    currency: string;
    onDate: string;
    configuredRuleId?: string | null;
  },
): Promise<SurchargeResolution> {
  const configuredRuleId = opts.configuredRuleId ?? null;
  if (configuredRuleId !== null) {
    assertAcceptanceUuid(configuredRuleId, "surcharge rule");
    // Refuses by name when the explicit rule cannot price this quote
    // (wrong provider/method, retired, or outside its effective window) —
    // the resolution below must never fall back to another rule instead.
    await validateConfiguredSurchargeRule(orgId, opts.provider, configuredRuleId, {
      onDate: opts.onDate,
    });
    const r = await db.execute<{
      id: string;
      calculation: string;
      percent: string | null;
      fixed_amount: string | null;
      cap_amount: string | null;
      fee_income_account_id: string;
    }>(
      sql`
      select id, calculation, percent, fixed_amount, cap_amount, fee_income_account_id
        from payment_surcharge_rules
       where org_id = ${orgId} and id = ${configuredRuleId} and is_active
         and effective_from <= ${opts.onDate}
         and (effective_to is null or effective_to >= ${opts.onDate})
         and (provider is null or provider = ${opts.provider})
         and payment_method in ('all', ${providerPaymentMethod(opts.provider)})
       limit 1
    `,
      "objects",
    );
    const rule = r[0];
    // Unreachable unless the rule changed between the validation above and
    // this read: fail closed on the explicit reference rather than falling
    // back to whatever rule happens to match.
    if (!rule) {
      throw new PaymentAcceptanceError(
        `surcharge rule ${configuredRuleId} stopped covering this quote; ` +
          "choose an active surcharge rule in Company Settings → Payment Providers",
      );
    }
    await validateSurchargeIncomeAccount(orgId, rule.fee_income_account_id);
    const amount = quantizeSurchargeToMinorUnits(
      computeSurcharge(opts.amount, rule),
      opts.currency,
    );
    return { amount, ruleId: rule.id, feeIncomeAccountId: rule.fee_income_account_id };
  }
  const r = await db.execute<{
    id: string;
    calculation: string;
    percent: string | null;
    fixed_amount: string | null;
    cap_amount: string | null;
    fee_income_account_id: string;
  }>(
    sql`
    select id, calculation, percent, fixed_amount, cap_amount, fee_income_account_id
      from payment_surcharge_rules
     where org_id = ${orgId} and is_active
       and effective_from <= ${opts.onDate}
       and (effective_to is null or effective_to >= ${opts.onDate})
       and (provider is null or provider = ${opts.provider})
       and payment_method in ('all', ${providerPaymentMethod(opts.provider)})
     order by case when provider = ${opts.provider} then 1 else 2 end,
               effective_from desc,
               id desc
     limit 1
  `,
    "objects",
  );
  const rule = r[0];
  if (!rule) return { amount: "0", ruleId: null, feeIncomeAccountId: null };
  await validateSurchargeIncomeAccount(orgId, rule.fee_income_account_id);
  // The quote must be collectible: currency is required so the fee arrives
  // in whole minor units rather than stranding checkout at the adapter.
  const amount = quantizeSurchargeToMinorUnits(computeSurcharge(opts.amount, rule), opts.currency);
  return { amount, ruleId: rule.id, feeIncomeAccountId: rule.fee_income_account_id };
}

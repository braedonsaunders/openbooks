export type ProviderKey = "stripe" | "adyen" | "gocardless";
export type AutomationProviderKey = "paypal" | "shopify_payments" | "square";

export interface PaymentProviderConfig {
  provider: ProviderKey;
  displayName: string;
  isEnabled: boolean;
  acceptanceEnabled: boolean;
  defaultBankAccountId: string | null;
  publishableKey: string | null;
  surchargeRuleId: string | null;
  settings: Record<string, unknown>;
  hasSecrets: boolean;
  lastError: string | null;
  defaultDisputedFundsAccountId: string | null;
  defaultChargebackLossAccountId: string | null;
  defaultDisputeFeeAccountId: string | null;
}

export interface PaymentAutomationConfig {
  provider: AutomationProviderKey;
  displayName: string;
  isEnabled: boolean;
  defaultDisputedFundsAccountId: string | null;
  defaultChargebackLossAccountId: string | null;
  defaultDisputeFeeAccountId: string | null;
}

export interface PaymentProviderAccount {
  id: string;
  number: string | null;
  name: string;
}

export interface PaymentSurchargeRule {
  id: string;
  name: string;
  calculation: string;
  percent: string | null;
  fixedAmount: string | null;
  capAmount: string | null;
  feeIncomeAccountId: string | null;
  provider: ProviderKey | null;
  paymentMethod: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  isActive: boolean;
}

export interface PaymentProviderSetupData {
  featureEnabled: boolean;
  bankingEnabled: boolean;
  configs: PaymentProviderConfig[];
  automationConfigs: PaymentAutomationConfig[];
  bankAccounts: PaymentProviderAccount[];
  incomeAccounts: PaymentProviderAccount[];
  postingAccounts: PaymentProviderAccount[];
  surchargeRules: PaymentSurchargeRule[];
}

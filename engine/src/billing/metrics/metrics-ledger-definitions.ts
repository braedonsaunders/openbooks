import { UsageBillingError } from "../usage/errors.ts";

export const FEATURES_REMEDY = "Enable SaaS metrics in Company Settings → Features.";
export const CLOSED_PERIOD_REMEDY =
  "Reopen the period through the period-close flow to compute a new snapshot, or accept the frozen month and leave its recorded facts unchanged.";

export interface SaasMetricsDefinitions {
  orgId: string;
  evergreenBookingMonths: string;
  billingsUsePreTaxSubtotal: boolean;
  customerCreditsReduceBillings: boolean;
}

/** Read the tenant's SaaS metrics policy, using the former resolver values for unset fields. */
export function saasMetricsDefinitions(
  orgId: string,
  rawSettings: unknown,
): SaasMetricsDefinitions {
  const settings =
    rawSettings !== null && typeof rawSettings === "object" && !Array.isArray(rawSettings)
      ? (rawSettings as Record<string, unknown>)
      : {};
  const stored = settings.saasMetrics;
  const definitions =
    stored === undefined
      ? {}
      : stored !== null && typeof stored === "object" && !Array.isArray(stored)
        ? (stored as Record<string, unknown>)
        : null;
  if (!definitions) {
    throw new UsageBillingError(
      "saas_metrics_definition_invalid",
      "SaaS metrics definitions must be stored as an object.",
      "Correct the definitions in Company Settings → Setup → Company, then recompute SaaS metrics.",
      { field: "saasMetrics" },
    );
  }
  const evergreenBookingMonths = definitions.evergreenBookingMonths ?? "12";
  if (typeof evergreenBookingMonths !== "string" || !/^[1-9]\d*$/.test(evergreenBookingMonths)) {
    throw new UsageBillingError(
      "saas_metrics_definition_invalid",
      "Evergreen booking term must be a positive whole number of months.",
      "Enter a positive whole number of months in Company Settings → Setup → Company.",
      { field: "evergreenBookingMonths" },
    );
  }
  const billingsUsePreTaxSubtotal = definitions.billingsUsePreTaxSubtotal ?? true;
  if (typeof billingsUsePreTaxSubtotal !== "boolean") {
    throw new UsageBillingError(
      "saas_metrics_definition_invalid",
      "Billings basis must be a boolean setting.",
      "Choose the billings basis in Company Settings → Setup → Company.",
      { field: "billingsUsePreTaxSubtotal" },
    );
  }
  const customerCreditsReduceBillings = definitions.customerCreditsReduceBillings ?? true;
  if (typeof customerCreditsReduceBillings !== "boolean") {
    throw new UsageBillingError(
      "saas_metrics_definition_invalid",
      "Customer-credit treatment must be a boolean setting.",
      "Choose the customer-credit treatment in Company Settings → Setup → Company.",
      { field: "customerCreditsReduceBillings" },
    );
  }
  return {
    orgId,
    evergreenBookingMonths,
    billingsUsePreTaxSubtotal,
    customerCreditsReduceBillings,
  };
}

export interface SaasMetricsRecomputeResult {
  orgId: string;
  month: string;
  subscriptionRows: number;
  subsidiaryRows: number;
  frozen: boolean;
}

export interface SaasMetricsScanTargets {
  enabledOrgIds: string[];
  skippedFeatureOffOrgIds: string[];
}

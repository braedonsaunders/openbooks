export interface LossOfControlFormDefaults {
  investment_account_id: string;
  equity_income_account_id: string;
}

export function initialLossOfControlFormState(
  today: string,
  defaults: LossOfControlFormDefaults | null,
  key: string,
) {
  return {
    values: {
      effectiveOn: today,
      retainedMethod: "none",
      parentRetainedCarrying: "0",
      retainedPercent: "0",
      retainedFairValue: "0",
      ...(defaults
        ? {
            retainedAccountId: defaults.investment_account_id,
            equityIncomeAccountId: defaults.equity_income_account_id,
          }
        : {}),
    } satisfies Record<string, string>,
    rates: {} as Record<string, string>,
    oci: [] as {
      accountId: string;
      balance: string;
      treatment: "profit_loss" | "retained_earnings";
      destinationAccountId: string;
      description: string;
    }[],
    adjustments: [] as { lineId: string; amount: string }[],
    error: null as string | null,
    dirty: false,
    key,
  };
}

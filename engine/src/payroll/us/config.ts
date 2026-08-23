import { resolveStatutoryRates } from "../statutory-rates.ts";

/**
 * US pack configuration, resolved from the pack's declared rate slots
 * (engine/src/payroll/statutory-rates.ts) rather than from an org-level blob.
 */
export interface UsPayrollConfig {
  futaRate(state: string): string | null;
  sui(state: string, filingAccountId: string | null): { rate: string; wageBase: string } | undefined;
  subRegionRates(
    rateKey: string, region: string, subRegion: string,
  ): Record<string, string> | undefined;
}

export async function usPayrollConfig(orgId: string, taxYear: number): Promise<UsPayrollConfig> {
  const rates = await resolveStatutoryRates(orgId, "US", taxYear);
  return {
    futaRate: (state) => rates.values("us_futa", { region: state })?.rate ?? null,
    sui: (state, filingAccountId) => {
      const values = rates.values("us_sui", { region: state, filingAccountId });
      return values ? { rate: values.rate!, wageBase: values.wageBase! } : undefined;
    },
    subRegionRates: (rateKey, region, subRegion) =>
      rates.values(rateKey, { region, subRegion }) ?? undefined,
  };
}

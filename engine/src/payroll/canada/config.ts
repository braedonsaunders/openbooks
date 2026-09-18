import { resolveStatutoryRates } from "../statutory-rates.ts";

/**
 * CA pack configuration. EHT is levied by four provinces at four rates above
 * four exemptions, so it resolves PER PROVINCE; the Québec health services
 * fund is QC-only, rate-only (TP-1015.F-V s. 5 — no exemption), likewise
 * resolved per province so a stub outside QC never sees it.
 */
export interface CaPayrollConfig {
  eht(region: string): { rate: string; annualExemption: string | null } | null;
  hsf(region: string): { rate: string } | null;
}

export async function caPayrollConfig(orgId: string, taxYear: number): Promise<CaPayrollConfig> {
  const rates = await resolveStatutoryRates(orgId, "CA", taxYear);
  return {
    eht: (region) => {
      const values = rates.values("ca_eht", { region });
      if (!values?.rate) return null;
      return { rate: values.rate, annualExemption: values.annualExemption ?? null };
    },
    hsf: (region) => {
      const values = rates.values("ca_hsf", { region });
      if (!values?.rate) return null;
      return { rate: values.rate };
    },
  };
}

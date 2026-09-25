import { resolveStatutoryRates } from "../statutory-rates.ts";
import { CA_PACK_RATES } from "./rates.ts";

/**
 * CA pack configuration. EHT is levied by four provinces at four rates above
 * four exemptions, so it resolves PER PROVINCE; the Québec health services
 * fund is QC-only, rate-only (TP-1015.F-V s. 5 — no exemption), likewise
 * resolved per province so a stub outside QC never sees it.
 */
export interface CaPayrollConfig {
  eht(region: string): { rate: string; annualExemption: string | null } | null;
  hsf(region: string): {
    sectorOther: boolean;
    sectorPublic: boolean;
    sectorPrimaryManufacturing: boolean;
    sectorExempt2026: boolean;
  } | null;
}

export async function caPayrollConfig(
  orgId: string,
  taxYear: number,
  /** ISO pay date the resolution is as-of; null reads the current rows. */
  asOf: string | null = null,
): Promise<CaPayrollConfig> {
  const rates = await resolveStatutoryRates(orgId, CA_PACK_RATES, taxYear, asOf);
  return {
    eht: (region) => {
      const values = rates.values("ca_eht", { region });
      if (!values?.rate) return null;
      return { rate: values.rate, annualExemption: values.annualExemption ?? null };
    },
    hsf: (region) => {
      const values = rates.values("ca_hsf", { region });
      if (!values) return null;
      return {
        sectorOther: values.sectorOther === "true",
        sectorPublic: values.sectorPublic === "true",
        sectorPrimaryManufacturing: values.sectorPrimaryManufacturing === "true",
        sectorExempt2026: values.sectorExempt2026 === "true",
      };
    },
  };
}

/**
 * The BR pack's withholding jurisdiction: one country, one table.
 *
 * IRRF and INSS are federal and national — no state publishes its own
 * tables, so the single region is the country itself and it is implemented
 * now that the 2026 engine computes end to end. There is no employee-filed
 * withholding certificate (dependents reach the engine as employer-held
 * cadastre facts, `br_dependentes`), hence no certificateKey.
 *
 * Non-residents are outside monthly CLT withholding (25% exclusive source
 * taxation): `taxesNonresidentWages: false` with the reason naming it.
 */
import type {
  PayrollPackWithholding,
} from "../withholding-jurisdictions.ts";

export const BR_WITHHOLDING: PayrollPackWithholding = {
  country: "BR",
  regions: [
    {
      region: "BR",
      label: "IRRF + INSS (tabela nacional)",
      implemented: true,
      taxesNonresidentWages: false,
      residentWithholding: "unknown",
      residentWithholdingImplemented: false,
      subRegions: [],
      subRegionConflictRule: "work_only",
      citation:
        "Lei 7.713/1988; Lei 9.250/1995 arts. 4º, 10 e 3º-A (Lei 15.270/2025); "
        + "Lei 11.482/2007 art. 1º XII (MP 1.294/2025); EC 103/2019; "
        + "Portaria Interministerial MPS/MF nº 13/2026",
    },
  ],
};

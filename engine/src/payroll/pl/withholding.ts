/**
 * The PL pack's withholding declaration: one national region.
 *
 * PIT advances (art. 32 updof) and ZUS contributions are both national —
 * no voivodeship levies its own income tax — so the one known region is
 * the country itself, and it is supported now that the monthly advance
 * plus standard contributions compute end to end.
 *
 * Per-employee gaps stay at the per-employee channel, never in `supported`
 * (FR precedent): the under-26 exemption, the FP 55–60 band and non-standard
 * titles refuse by name off the certificate and the birth year inside
 * compute-statutory.ts.
 */
import type { PayrollPackWithholding } from "../withholding-jurisdictions.ts";

export const PL_WITHHOLDING: PayrollPackWithholding = {
  country: "PL",
  regions: [
    {
      region: "PL",
      label: "Zaliczki na PIT i składki ZUS (ogólnokrajowe)",
      // Implemented: the 2026 skala + 120 000 zł advance test, KUP 250/300,
      // the 300 zł oświadczenie reduction, and standard ZUS/NFZ/FP/FS/FGŚP
      // price a monthly employment payslip end to end. Wypadkowe (tenant
      // rate), ulga dla młodych, PPK and non-employment titles stay refused
      // by name (see PL_REFUSALS_2026).
      implemented: true,
      // Employment income for work performed in Poland is subject to payer
      // advances under the same art. 32 mechanism — a separate non-resident
      // flat-rate regime is not modelled here.
      taxesNonresidentWages: true,
      residentWithholding: "required",
      residentWithholdingImplemented: true,
      certificateKey: "pl_pit2",
      subRegions: [],
      // Vacuous: Poland declares no sub-region wage levies, so no comparison
      // ever runs. Revisit if one is ever declared.
      subRegionConflictRule: "work_only",
      citation:
        "Ustawa o podatku dochodowym od osób fizycznych, art. 32 (zaliczki) "
        + "i art. 27 ust. 1 (skala); ustawa o systemie ubezpieczeń "
        + "społecznych, art. 16 i 22 (składki ZUS)",
    },
  ],
};

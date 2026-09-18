/**
 * The IT pack's withholding jurisdictions: one entry per region, every one
 * of them unimplemented.
 *
 * Italy withholds through the sostituto d'imposta mechanism (art. 23 DPR 29
 * settembre 1973, n. 600): the employer computes IRPEF plus the domicile
 * region's addizionale regionale and the domicile comune's addizionale
 * comunale, and pays everything through Modello F24. The regions below are
 * therefore refused for a precise, named reason — the regional and municipal
 * surcharge tables for the year are not transcribed — and not because the
 * geography is unknown.
 *
 * Domicile, not workplace, selects the surcharge (D.Lgs. 15 dicembre 1997,
 * n. 446 for the regions; D.Lgs. 28 settembre 1998, n. 360 for the comuni;
 * the CU form itself carries the employee's domicilio fiscale at 1 January
 * and 31 December for exactly this computation). That is what the two
 * residence declarations below say: a region does not tax a nonresident's
 * wages earned there (`taxesNonresidentWages: false`), and a resident's
 * out-of-region wages still carry the domicile region's surcharge
 * (`residentWithholding: "required"`, unimplemented until an engine reads
 * the domicile).
 *
 * No certificate key: Italy publishes no regional withholding allowance
 * certificate. The one employee-filed input (the detrazioni declaration,
 * artt. 12–13 TUIR) is national — see certificates.ts — the way
 * Pennsylvania publishes no certificate at all.
 *
 * No sub-regions yet: the ~7,900 comuni each deliberate their own aliquota
 * (and optional exemption threshold) annually, published in the MEF dataset.
 * Carrying them as pack constants would be wrong for whichever comune was
 * revised after the release, so they will need the open-sub-region shape
 * (the Pennsylvania Act 32 pattern) once an engine exists to read it.
 */
import type { PayrollPackWithholding } from "../withholding-jurisdictions.ts";
import { IT_REGIONS } from "./regions.ts";

const UNIMPLEMENTED_REASON =
  "IRPEF withholding for {region} is not implemented by the IT payroll pack: no tax-year edition is "
  + "transcribed (see engine/src/payroll/it/rates.ts), so neither the national IRPEF brackets nor the "
  + "region's addizionale regionale and the comune's addizionale comunale can be computed. Transcribe "
  + "the year's Legge di Bilancio tables, the INPS circular, and the MEF addizionali dataset.";

export const IT_WITHHOLDING: PayrollPackWithholding = {
  country: "IT",
  regions: IT_REGIONS.map((region) => ({
    region: region.code,
    label: `Addizionale regionale — ${region.name}`,
    implemented: false,
    unimplementedReason: UNIMPLEMENTED_REASON.replace("{region}", region.name),
    // Surcharges follow the fiscal domicile, never the workplace: working in
    // a region without living there creates no liability to that region.
    taxesNonresidentWages: false,
    residentWithholding: "required",
    residentWithholdingImplemented: false,
    // No regional certificate exists; the national detrazioni declaration
    // (it_detrazioni) is the pack's only employee-filed withholding input.
    certificateKey: undefined,
    subRegions: [],
    // Vacuous until the comuni are declared as open sub-regions.
    subRegionConflictRule: "both",
    citation:
      "DPR 29 settembre 1973, n. 600, art. 23; D.Lgs. 15 dicembre 1997, n. 446; "
      + "D.Lgs. 28 settembre 1998, n. 360",
  })),
};

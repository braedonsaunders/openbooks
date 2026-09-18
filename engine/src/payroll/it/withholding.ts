/**
 * The IT pack's withholding jurisdictions: one entry per region, computed
 * from tenant-declared surtax rates since the 2025 edition.
 *
 * Italy withholds through the sostituto d'imposta mechanism (art. 23 DPR 29
 * settembre 1973, n. 600): the employer computes IRPEF plus the domicile
 * region's addizionale regionale and the domicile comune's addizionale
 * comunale, and pays everything through Modello F24.
 *
 * Domicile, not workplace, selects the surcharge (D.Lgs. 15 dicembre 1997,
 * n. 446 for the regions; D.Lgs. 28 settembre 1998, n. 360 for the comuni;
 * the CU form itself carries the employee's domicilio fiscale at 1 January
 * and 31 December for exactly this computation — 730/2026: "Il domicilio
 * fiscale consente di individuare la Regione e il Comune per i quali è
 * dovuta rispettivamente l'addizionale regionale e comunale").
 *
 * The ~7,900 comuni are an OPEN set (the Pennsylvania Act 32 pattern): each
 * deliberate its own aliquota (single or banded), exemption threshold and
 * casi particolari yearly — the AdE Elenco addizionale comunale 2025 alone
 * runs to 196 pages — so the pack declares the shape (codice catastale,
 * resident reach, tenant rate) and the employer enters the domicile's
 * deliberated figures. A code outside the catastale pattern is refused by
 * name; a deliberation the flat slots cannot carry (banded schedules, casi
 * particolari tipizzazioni, regional detrazioni) is refused by name in the
 * engine, never approximated.
 *
 * No certificate key at region level: Italy publishes no regional
 * withholding allowance certificate. The one employee-filed input (the
 * detrazioni declaration, artt. 12–13 TUIR) is national — see
 * certificates.ts — and carries the domicile-comune code answer the open
 * sub-regions resolve through.
 */
import type { PayrollPackWithholding } from "../withholding-jurisdictions.ts";
import { IT_REGIONS } from "./regions.ts";

export const IT_WITHHOLDING: PayrollPackWithholding = {
  country: "IT",
  regions: IT_REGIONS.map((region) => ({
    region: region.code,
    label: `Addizionale regionale — ${region.name}`,
    implemented: true,
    // Surcharges follow the fiscal domicile, never the workplace: working in
    // a region without living there creates no liability to that region.
    taxesNonresidentWages: false,
    residentWithholding: "required",
    residentWithholdingImplemented: true,
    // No regional certificate exists; the national detrazioni declaration
    // (it_detrazioni) is the pack's only employee-filed withholding input.
    certificateKey: undefined,
    subRegions: [],
    openSubRegions: {
      kind: "comune",
      label: "Addizionale comunale — {code}",
      codePattern: "^[A-Z][0-9]{3}$",
      reaches: ["resident"],
      rateSource: { kind: "tenant", rateKey: "it_addizionale_comunale" },
      certificateKey: "it_detrazioni",
      citation:
        "D.Lgs. 28 settembre 1998, n. 360; AdE Elenco addizionale comunale 2025",
      implemented: true,
    },
    // One domicile, one comune: the residence comune's surcharge is the only
    // one withheld, so there is no work/residence comparison to settle.
    subRegionConflictRule: "residence_only",
    citation:
      "DPR 29 settembre 1973, n. 600, art. 23; D.Lgs. 15 dicembre 1997, n. 446; "
      + "D.Lgs. 28 settembre 1998, n. 360",
  })),
};

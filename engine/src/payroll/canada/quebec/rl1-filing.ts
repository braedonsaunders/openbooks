import {
  registerYearEndFiling,
  type PayrollFilingSlipData,
  type PayrollYearEndFiling,
} from "../../../payroll-filing-registry.ts";
import { rl1Population, rl1Slips, RL1_UNSUPPORTED_BOXES } from "../../../payroll-rl1.ts";
import { RL1_AMENDMENT_REFUSAL, RL1_XML_DOWNLOAD_REFUSAL } from "../../../payroll-rl1xml.ts";
import { PayrollError } from "../../../payroll-run.ts";

/**
 * The Quebec RL-1's year-end filing declaration — the jurisdiction-within-a-
 * country registration the filing registry was built for: the RL-1 attaches
 * to the CA pack's year-end surface from here, without owning the pack's
 * declaration (engine/src/payroll-filing-registry.ts, registerYearEndFiling).
 *
 * The slip data builder lives in engine/src/payroll-rl1.ts; the transmission
 * mechanics and the XML refusal in engine/src/payroll-rl1xml.ts. No download
 * builder is declared — the tag-level RL-1 XML specification is partner-gated
 * at Revenu Québec, so the declaration carries the named `downloadRefusal`
 * instead of a file nobody could validate.
 *
 * No bootstrap call is required: the CA pack's own filing declaration
 * (engine/src/payroll/canada/filings.ts) carries `rl1Filing()` directly, so
 * the year-end surface enumerates the RL-1 wherever the pack is declared.
 * `registerRl1Filing()` remains as the idempotent registration path for
 * callers that want to attach it explicitly (tests do).
 */
/**
 * Built LAZILY (first lookup, never module evaluation): this module sits in
 * the same import cycle as the pack filing declarations — packs.ts reaches
 * canada/filings.ts, which reaches this module, which reaches payroll-rl1.ts,
 * which reaches payroll-run.ts, which reaches packs.ts — so dereferencing
 * another module's consts (RL1_UNSUPPORTED_BOXES, RL1_XML_DOWNLOAD_REFUSAL)
 * during evaluation is a TDZ crash whenever the cycle enters elsewhere.
 * Memoized, so the object the CA declaration carries and the object
 * `registerRl1Filing()` registers are ONE object (registerYearEndFiling is
 * idempotent on the identical declaration).
 */
let cached: PayrollYearEndFiling | null = null;

/** One employee's RL-1, box by box — the form's own codes and French titles. */
async function rl1Slip(orgId: string, taxYear: number, rowId: string): Promise<PayrollFilingSlipData> {
  const slips = await rl1Slips(orgId, taxYear);
  const slip = slips.find((s) => s.employeePartyId === rowId);
  if (!slip) {
    throw new PayrollError(`no ${taxYear} RL-1 slip matches the requested employee`);
  }
  return {
    formCode: "CA_RL1",
    formName: "Relevé 1 — Revenus d'emploi et revenus divers",
    formNumber: "RL-1",
    headerFields: [
      { label: "Nom du particulier — employee's name", value: slip.employeeName },
      { label: "Année d'imposition — tax year", value: String(taxYear) },
    ],
    boxes: [
      { code: "A", label: "Revenus d'emploi", value: slip.boxA },
      { code: "B.A", label: "Cotisation au RRQ", value: slip.boxBA },
      { code: "B.B", label: "Cotisation supplémentaire au RRQ", value: slip.boxBB },
      { code: "C", label: "Cotisation à l'assurance emploi", value: slip.boxC },
      { code: "E", label: "Impôt du Québec retenu à la source", value: slip.boxE },
      { code: "F", label: "Cotisation syndicale", value: slip.boxF },
      { code: "G", label: "Salaire admissible au RRQ", value: slip.boxG },
      { code: "H", label: "Cotisation au RQAP", value: slip.boxH },
      { code: "I", label: "Salaire admissible au RQAP", value: slip.boxI },
    ],
    notes: [RL1_UNSUPPORTED_BOXES],
  };
}

export function rl1Filing(): PayrollYearEndFiling {
  cached ??= {
    key: "rl1",
    label: "RL-1 slips (Revenu Québec)",
    cadence: "annual",
    description:
      "Revenus d'emploi et revenus divers — the Québec-side year-end slip a QC "
      + "employee receives alongside their T4. Boxes A, B.A/B.B (QPP), C (EI), "
      + "E (Québec income tax), F (union dues), G/I (QPP/QPIP eligible salary) "
      + "and H (QPIP) are built from committed stubs. "
      + RL1_UNSUPPORTED_BOXES,
    emptyText: "No committed Québec pay stubs for this year.",
    population: (orgId, taxYear) => rl1Population(orgId, taxYear),
    slip: { build: (orgId, taxYear, rowId) => rl1Slip(orgId, taxYear, rowId) },
    downloadRefusal: RL1_XML_DOWNLOAD_REFUSAL,
    // Revenu Québec's amended/cancelled RL-1 is its OWN shape — the "R" record
    // carries an amendment code and the amended slip must quote the sequential
    // number of the slip it replaces, both specified in the same partner-gated
    // documents (Guide de préparation du relevé 1 en format XML; guide IN-800)
    // that keep the original RL-1 XML out of reach. Nothing about the
    // correction format is publicly published, and a guessed amendment code or
    // a slip that fails to identify its predecessor would produce a second
    // original — two RL-1s for one employee, on Revenu Québec's file.
    amendment: {
      supported: false,
      refusal: RL1_AMENDMENT_REFUSAL,
    },
  };
  return cached;
}

let registered = false;

/** Attach the RL-1 to the CA pack's year-end filings. Idempotent. */
export function registerRl1Filing(): void {
  if (registered) return;
  registerYearEndFiling("CA", rl1Filing());
  registered = true;
}

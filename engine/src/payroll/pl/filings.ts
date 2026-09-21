/**
 * The PL pack's filing declaration: the ZUS payer account plus the PIT-11
 * employee information return.
 *
 * - ZUS settles monthly through the payer's account (deklaracja
 *   rozliczeniowa ZUS DRA via PUE/eZUS) against the employer's NIP/REGON
 *   identity — hence the one program type. The monthly DRA/RCA/RSA
 *   declarations are a separate submission channel and no builder exists
 *   for them: the PIT-11 below names that scope gap on its face rather
 *   than implying coverage.
 * - PIT advances settle with the właściwy urząd skarbowy (KAS): the
 *   employer declares them annually on PIT-4R (due by the end of January)
 *   and informs each employee — and that employee's tax office — on
 *   PIT-11 (to the office by the end of January electronically, to the
 *   employee by the end of February). The PIT-11 is the employee-facing
 *   statement, so it is the filing this pack declares; the PIT-4R total
 *   reconciles to the same committed runs (the sum of poz. 33) without a
 *   second declaration.
 */
import type { PayrollPackFilings } from "../filing-registry.ts";
import {
  parsePit11RowId,
  pit11ConfidentialFields,
  pit11CorrectionSlip,
  pit11Population,
  pit11Slip,
} from "./pit11.ts";

export function plPackFilings(): PayrollPackFilings {
  return {
    country: "PL",
    programTypes: [
      {
        key: "pl_zus_platnik",
        label: "ZUS konto płatnika składek (DRA)",
      },
    ],
    yearEnd: [
      {
        key: "pit11",
        label: "PIT-11 employee information",
        cadence: "annual",
        description:
          "PIT-11 information on employment income paid and advances withheld (Ministerstwo "
          + "Finansów, PIT-11(29)), one per employee with committed PL pay stubs. The PIT-4R "
          + "annual advances total reconciles to the same committed runs — the sum of poz. 33 — "
          + "without a second declaration. ZUS monthly declarations (DRA/RCA/RSA, the separate "
          + "PUE/eZUS channel) are out of scope and are not produced.",
        emptyText: "No committed PL pay stubs for this year.",
        population: (orgId, taxYear) => pit11Population(orgId, taxYear),
        parseRowId: parsePit11RowId,
        slip: { build: (orgId, taxYear, rowId) => pit11Slip(orgId, taxYear, rowId) },
        downloadRefusal:
          "the PL pack produces no PIT-11 electronic file (e-Deklaracje XML) — the box data "
          + "is complete on screen; transmit PIT-11 informations through the Ministry's "
          + "e-Deklaracje / e-Urząd Skarbowy channel",
        // A PIT-11 is corrected by re-filing the SAME information with
        // poz. 7 marked "korekta informacji" (Ordynacja podatkowa art. 81 —
        // the form's own footnote 8). There is no separate correction form
        // and no cancellation code: a slip that should never have existed
        // is withdrawn by a zero-amount korekta, which is still an
        // `amended` revision — so this filing declares `amended` and ONLY
        // `amended`.
        amendment: {
          supported: true,
          revisions: ["amended"],
          vehicle: "same_form",
          slip: { build: async (row) => pit11CorrectionSlip(row) },
          downloadRefusal:
            "no electronic PIT-11 korekta file is generated, the same gap the original "
            + "information declares — the as-filed/amended boxes above are complete; file "
            + "the korekta through the Ministry's e-Deklaracje / e-Urząd Skarbowy channel",
          confidential: (orgId, taxYear, rowId) => pit11ConfidentialFields(orgId, taxYear, rowId),
        },
      },
    ],
  };
}

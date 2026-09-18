/**
 * The AU pack's filing declaration.
 *
 * Single Touch Payroll (STP) is the reporting channel: the employer sends
 * tax and super information to the ATO on payday through STP-enabled
 * software and makes a finalisation declaration (due 14 July) once the
 * year-to-date figures for the financial year are complete. STP is a filing
 * on this pack, not a second engine.
 */
import type { PayrollPackFilings } from "../../payroll-filing-registry.ts";
import { PayrollPackError } from "../payroll-error.ts";

const STP_FINALISATION_REFUSAL =
  "AU STP finalisation is declared but not populated: pay-event and "
  + "finalisation populations have not been transcribed from the ATO STP "
  + "employer reporting guidelines";

export function auPackFilings(): PayrollPackFilings {
  return {
    country: "AU",
    programTypes: [
      {
        key: "ato_stp",
        label: "Single Touch Payroll (STP)",
      },
    ],
    yearEnd: [
      {
        key: "stp_finalisation",
        label: "STP finalisation declaration",
        cadence: "annual",
        description:
          "The employer's declaration that STP year-to-date figures for the "
          + "financial year are complete and final (due 14 July). Reported "
          + "through STP-enabled software — "
          + "https://www.ato.gov.au/businesses-and-organisations/"
          + "hiring-and-paying-your-workers/single-touch-payroll",
        population: async () => {
          throw new PayrollPackError(STP_FINALISATION_REFUSAL);
        },
        parseRowId: () => null,
        downloadRefusal:
          "There is no ATO file this product builds: STP pay events and the "
          + "finalisation indicator are lodged from STP-enabled payroll "
          + "software, not from a downloadable return",
        amendment: {
          supported: false,
          refusal:
            "STP corrections travel as STP update events and amended "
            + "finalisation events lodged through STP-enabled software; this "
            + "pack declares no correction mechanics yet",
        },
      },
    ],
  };
}

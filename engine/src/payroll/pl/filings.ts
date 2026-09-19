/**
 * The PL pack's filing declaration: the ZUS payer account, with no
 * year-end builders yet.
 *
 * - ZUS settles monthly through the payer's account (deklaracja
 *   rozliczeniowa ZUS DRA via PUE/eZUS) against the employer's NIP/REGON
 *   identity — hence the one program type.
 * - PIT advances settle with the właściwy urząd skarbowy (KAS) on PIT-4R
 *   with the annual PIT-11 information. No 4R/11 builder exists, so
 *   `yearEnd` is empty rather than approximate — a channel question for
 *   Orchestrate, not a second engine.
 */
import type { PayrollPackFilings } from "../../payroll-filing-registry.ts";

export function plPackFilings(): PayrollPackFilings {
  return {
    country: "PL",
    programTypes: [
      {
        key: "pl_zus_platnik",
        label: "ZUS konto płatnika składek (DRA)",
      },
    ],
    yearEnd: [],
  };
}

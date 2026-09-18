/**
 * The GB pack's statutory pass: PAYE income tax and Class 1 National
 * Insurance (primary and secondary).
 *
 * It REFUSES. There is no partial PAYE: a cumulative-basis withholding engine
 * fed placeholder bands would produce numbers indistinguishable on the stub
 * from correct ones, so an untranscribed year throws before any line is
 * pushed — the same failure mode `ratesForPayDate` (T4127) already implements
 * for the CA pack, reached one layer earlier so the refusal names the pack
 * and the publication instead of a table lookup.
 */

import { PayrollPackError } from "../packs.ts";
import type { PayrollStatutoryComputeContext } from "../statutory-context.ts";

/** Why the GB engine cannot calculate: named years, named publication. */
export function gbUntranscribedReason(taxYear: number): string {
  return (
    `the GB payroll pack has no transcribed PAYE/National Insurance tables for ${taxYear} — `
    + "transcribe the 2026/27 HMRC employer tables "
    + "(https://www.gov.uk/guidance/rates-and-thresholds-for-employers-2026-to-2027) "
    + "into engine/src/payroll/gb/ like a US state engine (see GB_TAX_YEARS), then set installable: true"
  );
}

export async function computeGbStatutory(
  ctx: PayrollStatutoryComputeContext,
): Promise<Record<string, string>> {
  ctx.assertRegionSupported(ctx.region);
  throw new PayrollPackError(gbUntranscribedReason(ctx.taxYear));
}

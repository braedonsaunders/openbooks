/**
 * The AU pack's statutory pass.
 *
 * Skeleton: it refuses by name. PAYG withholding (ATO Schedule 1) has not
 * been transcribed for any year — both the 2025–26 and 2026–27 editions sit
 * at `draft` in ./rates.ts — so any calculation would be silent wrong money.
 * The refusal names the year the run asked for.
 */
import { PayrollPackError } from "../packs.ts";
import type { PayrollStatutoryComputeContext } from "../statutory-context.ts";

export async function computeAuStatutory(
  ctx: PayrollStatutoryComputeContext,
): Promise<Record<string, string>> {
  throw new PayrollPackError(
    `AU PAYG withholding for tax year ${ctx.taxYear} has not been transcribed `
    + "— the AU payroll pack declares no published edition (see AU_TAX_YEARS "
    + "in engine/src/payroll/au/rates.ts). Transcribe ATO Schedule 1 for the "
    + "year before calculating",
  );
}

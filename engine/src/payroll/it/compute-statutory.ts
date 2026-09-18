/**
 * The IT pack's statutory pass: a named refusal for every tax year.
 *
 * No edition is transcribed (see rates.ts), so there is nothing to compute
 * with. The refusal names the requested year, the missing module, and the
 * 2026 blocker, because "unsupported year" without a reason reads as a bug
 * and gets retried per employee per run.
 *
 * The error extends the payroll base error directly rather than the pack
 * error in packs.ts: this pack is not registered in PAYROLL_COUNTRY_PACKS
 * yet, and importing packs.ts here would drag the generic graph (db, both
 * registered packs) into every consumer of this directory. The hierarchy is
 * preserved — callers catching the payroll base still catch this — and the
 * switch to the pack error is a one-line change when Orchestrate opens the
 * `PayrollCountry` union (packs/proposals/payroll-country-union.md).
 */
import { PayrollError } from "../../payroll-error.ts";
import type { PayrollStatutoryComputeContext } from "../statutory-context.ts";

export class ItPayrollRefusal extends PayrollError {}

/** Phase 9 — IT pack statutory pass. Refuses until an edition is transcribed. */
export async function computeItStatutory(
  ctx: PayrollStatutoryComputeContext,
): Promise<Record<string, string>> {
  throw new ItPayrollRefusal(
    `IT payroll pack has no transcribed tables for tax year ${ctx.taxYear}: 2026 is refused by name `
    + "(L. 199/2025 rewrote the second IRPEF bracket and the AdE rates page is internally inconsistent; "
    + "INPS and addizionali tables are likewise untranscribed). Transcribe "
    + "engine/src/payroll/it/rates.ts following IT_TAX_YEARS.scaffold.",
  );
}

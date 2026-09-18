/**
 * Phase 9 — ES pack statutory pass. REFUSES: no statutory year is transcribed
 * (see ./rates.ts), so any calculation would be invented money.
 */
import { PayrollPackError } from "../packs.ts";

// No context parameter: the pack refuses before reading anything, and an
// unread parameter would trip the repo's zero-headroom unused-vars gate.
export async function computeEsStatutory(): Promise<Record<string, string>> {
  throw new PayrollPackError(
    "the ES payroll pack cannot calculate: no statutory year is transcribed — the 2026 AEAT "
    + "retention algorithm and the 2026 TGSS contribution tables are not loaded "
    + "(engine/src/payroll/es/rates.ts), and the foral tables for Navarra and the Basque "
    + "Historical Territories (Álava/Araba, Gipuzkoa, Bizkaia) are refused until transcribed. "
    + "Transcribe the published figures and flip the pack to installable before paying.",
  );
}

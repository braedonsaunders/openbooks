/**
 * The JP pack's filing declaration: social-insurance establishment + refusals.
 *
 * Declared as PROGRAM TYPES (registrations the employer holds), with no
 * year-end builders yet:
 * - Social insurance settles establishment by establishment: the employer
 *   files 算定基礎届/月額変更届 and pays on the 納入告知書 against its
 *   社会保険適用事業所 registration with the Japan Pension Service — hence
 *   the one program type.
 * - Withholding income tax is remitted monthly (or twice-monthly for larger
 *   payers) on the 所得税徴収高計算書 to the tax office; no builder exists.
 * - 年末調整 (year-end adjustment) and the 法定調書 (源泉徴収票/給与支払報告
 *   書) are refused by name (see JP_REFUSED_2026 in ./rates.ts), so `yearEnd`
 *   is empty rather than approximate.
 */
import type { PayrollPackFilings } from "../filing-registry.ts";

export function jpPackFilings(): PayrollPackFilings {
  return {
    country: "JP",
    programTypes: [
      {
        key: "jp_shaho_jigyosho",
        label: "社会保険適用事業所 (JPS-registered establishment)",
      },
    ],
    yearEnd: [],
  };
}

/**
 * Pure box arithmetic for information returns (1099/T4A worksheets).
 *
 * Kept free of database imports on purpose: the filing worksheet client
 * component recomputes filed box amounts in the browser, and importing it from
 * information-returns.ts (which loads db.ts → pg) breaks the Next.js client
 * bundle with "Module not found: Can't resolve 'dns'/'fs'/'net'/'tls'".
 */
import { add } from "../money/money.ts";

/** Computed box amounts with the recipient's manual adjustments applied. */
export function filedBoxAmounts(
  computed: Record<string, string>,
  adjustments: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = { ...computed };
  for (const [box, delta] of Object.entries(adjustments)) {
    out[box] = add(out[box] ?? "0", delta);
  }
  return out;
}

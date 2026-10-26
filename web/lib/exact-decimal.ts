import { canonicalDecimal } from "@openbooks/engine/money/decimal";

export {
  canonicalDecimal,
  compareDecimal,
  isZeroDecimal,
  isPositiveDecimal,
  fixedDecimal,
  divideDecimal,
} from "@openbooks/engine/money/decimal";

/**
 * Editable spelling of a stored money amount. The stored text keeps its
 * numeric(19,4) padding ("5028.8200"); the input shows the canonical exact
 * decimal with trailing zeros dropped beyond the second place, and never fewer
 * than two ("5028.8200" → "5028.82", "5028.5000" → "5028.50", "-12" → "-12.00").
 * Text that is not plain decimal is returned as stored, so the operator sees
 * exactly what the server holds. No float is involved at any step.
 */
export function editableMoneyDecimal(stored: string | null | undefined): string {
  const text = stored?.trim() ?? "";
  if (text === "") return "";
  const canonical = canonicalDecimal(text, 4);
  if (canonical == null) return text;
  const [whole = "0", fraction = ""] = canonical.split(".");
  return `${whole}.${fraction.padEnd(2, "0")}`;
}

/**
 * Whether two money spellings name the same exact amount ("1000.00" and
 * "1000.0000" do). A blank value is no amount, and text that is not plain
 * decimal compares by its trimmed spelling only.
 */
export function sameMoneyDecimal(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  return moneyKey(left) === moneyKey(right);
}

function moneyKey(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  if (text === "") return null;
  return canonicalDecimal(text, 4) ?? text;
}

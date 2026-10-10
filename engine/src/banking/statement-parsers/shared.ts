/** Helpers shared by two or more statement parsers. Split from banking.ts (pure moves only). */
import { BankingError, type StatementBalanceRole } from "../banking-core"
import { assertLedgerRange } from "./bai2"
import { utcDateFromParts } from "../../platform/business-date.ts"
import { fromUnits, toUnits } from "../../money/money.ts"
import { decimalNullRefusal } from "../../money/decimal-refusal.ts"

// ---------------------------------------------------------------------------
// OFX parsing (1.x SGML and 2.x XML)
// ---------------------------------------------------------------------------

export function decodeOfxEntities(v: string): string {
  return v
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&");
}

export function assertRealDate(y: string, mo: string, d: string, label: string): string {
  const year = Number(y), month = Number(mo), day = Number(d);
  // utcDateFromParts keeps literal years 0001-0099 that Date.UTC would remap
  // onto 1900-1999 (an 0096 OFX date used to fail validation as "not real").
  const dt = utcDateFromParts(year, month - 1, day);
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day
  ) {
    throw new BankingError(`${label} is not a real calendar date`);
  }
  return `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Expand a two-digit BAI2/MT940 year onto the fixed supported window
 * 1969–2068 (POSIX pivot 69: 00–68 → 2000s, 69–99 → 1900s). The pivot is a
 * constant, never the current year: reparsing the same file always yields the
 * same dates. These formats cannot express a century, so statements outside
 * the window must arrive as OFX or CAMT.053 instead of guessing.
 */
export function expandTwoDigitYear(yy: string): string {
  const twoDigit = Number(yy);
  if (!Number.isInteger(twoDigit) || twoDigit < 0 || twoDigit > 99) {
    throw new BankingError(`Unparseable two-digit year "${yy}"`);
  }
  return String((twoDigit <= 68 ? 2000 : 1900) + twoDigit);
}

/**
 * Normalize a raw amount ("1,234.56", "(45.00)", "45.00-", "1.234,56") to a
 * signed decimal string.
 *
 * `commaMode` names where the figure came from, because a lone comma means
 * different things under different grammars. SWIFT MT940 amounts use the
 * decimal comma and never carry grouping, so there the comma is the point
 * by spec — not a guess. Human input (CSV cells, pasted figures, manual
 * statement lines) has no grammar: "1,234" is two readings, and silently
 * picking one is how a 1000x statement line happens — "12,345" is
 * twelve-point-three-four-five in every decimal-comma locale and 12345 in
 * every grouping one. There the ambiguous shape is refused with both
 * readings named, through the one shared decimal classifier.
 */
export function normalizeAmount(raw: string, label: string, commaMode: "swift-decimal" | "human" = "human"): string {
  let s = raw.trim().replace(/[$€£\s]/g, "");
  if (!s) throw new BankingError(`${label}: empty amount`);
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.endsWith("-")) {
    negative = true;
    s = s.slice(0, -1);
  }
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  const hasDot = s.includes(".");
  const hasComma = s.includes(",");
  if (hasDot && hasComma) {
    // rightmost separator is the decimal point
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      s = s.replace(/,/g, "");
    }
  } else if (hasComma) {
    if (commaMode === "swift-decimal") {
      // The SWIFT grammar: MT940 amounts carry no grouping separators, so
      // the comma is the decimal point by spec. "12,345" is 12.345 — the
      // three-decimal currencies (KWD, BHD, OMR, TND) write exactly this —
      // and the old grouping guess read it as 12345, a 1000x line.
      s = s.replace(/,/g, ".");
    } else {
      // A decimal comma with a one- or two-digit tail ("123,45") is
      // twelve-thirty-four written correctly in a decimal-comma locale.
      // Repeated three-digit groups ("1,234,567") settle the reading the
      // way a lone comma cannot. One comma with any other tail is two
      // readings, and a guess is a 1000x statement line — refuse it with
      // both readings named through the shared classifier; a second
      // implementation of that refusal would be the defect it prevents.
      const singleComma = (s.match(/,/g) ?? []).length === 1;
      if (singleComma && !/^(\d+),(\d{1,2})$/.test(s)) {
        throw new BankingError(decimalNullRefusal(label, "a statement amount", s, 4));
      }
      s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, "") : s.replace(/,/g, ".");
    }
  }
  let units: bigint;
  try {
    units = toUnits(s);
  } catch {
    throw new BankingError(`${label}: unparseable amount "${raw}"`);
  }
  units = negative ? -units : units;
  assertLedgerRange(units, `${label}: amount "${raw}" is out of range for the ledger`);
  return fromUnits(units);
}

/**
 * Opening/closing balance rows smuggled into transaction feeds: a summary
 * row ("Opening balance 3,068.57") with no GL counterpart blocks sign-off
 * forever when imported as a transaction, because statement lines can be
 * matched or excluded but a phantom transaction is neither. Detection is
 * deliberately conservative and English-keyword based — bank exports label
 * these rows in a small set of ways. A flagged row is offered as a balance
 * in the preview rather than imported, so a genuine transaction whose
 * description happens to lead with one of these phrases must be reworded
 * in the source text. A bare "Balance" with no direction word
 * is not enough: direction is what separates a balance from money.
 */
const BALANCE_TEXT = "balance|b/f|c/f|brought forward|carried forward";
const OPENING_LEAD =
  /^(opening|open|beginning|starting|previous|prior|brought forward|balance\s*b\/f|b\/f)\b/;
const CLOSING_LEAD =
  /^(closing|close|ending|final|new|current|carried forward|balance\s*c\/f|c\/f)\b/;

/** Opening/closing-balance role of a statement description, or null for a genuine transaction. */
export function detectStatementBalanceRole(
  description: string | null | undefined,
): StatementBalanceRole | null {
  const text = (description ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  if (!text) return null;
  if (!new RegExp(`\\b(${BALANCE_TEXT})\\b`).test(text)) return null;
  if (OPENING_LEAD.test(text)) return "opening";
  if (CLOSING_LEAD.test(text)) return "closing";
  return null;
}

const BALANCE_FILLER_WORD = /^(balances?|b\/f|c\/f)$/;
const AMOUNT_TOKEN = /^[$£€¥]?\d[\d,]*(\.\d+)?$/;

/**
 * Balance-summary rows for auto-match to leave alone. Import detection above
 * stays conservative (it needs the word "balance"), so a bare "Opening
 * 1,914.90" still imports as a transaction line — but it still has no GL
 * counterpart, and pairing it with a same-amount payment is the mismatch
 * this guard exists to prevent. A summary row is a lead word plus at most an
 * amount: once the lead, any amounts and balance fillers are set aside,
 * nothing may remain. Genuine traffic ("Open invoice 123", "Final payment
 * to vendor", "New equipment purchase") always has other words, so it still
 * pairs; the reviewer matches or excludes the summary row by hand.
 */
export function isBalanceSummaryRow(description: string | null | undefined): boolean {
  const text = (description ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  if (!text) return false;
  if (detectStatementBalanceRole(text) !== null) return true;
  if (!OPENING_LEAD.test(text) && !CLOSING_LEAD.test(text)) return false;
  const rest = text.replace(OPENING_LEAD.test(text) ? OPENING_LEAD : CLOSING_LEAD, "").trim();
  if (!rest) return true;
  return rest
    .split(" ")
    .every((token) => {
      const clean = token.replace(/^[^\p{L}\p{N}/]+|[^\p{L}\p{N}/]+$/gu, "");
      return AMOUNT_TOKEN.test(clean) || BALANCE_FILLER_WORD.test(clean);
    });
}

import { PaymentError } from "./payment-errors.ts";

/**
 * Text for offset-delimited bank records (NACHA, CPA-005, Cemtex, Bacs,
 * CNAB 240). Those files are served as us-ascii and every field sits at a
 * fixed byte offset, so a character that encodes to more than one byte —
 * "é" is two in UTF-8 — lengthens its record and shifts every field after it.
 * Fields are therefore measured only after the text is reduced to printable
 * ASCII.
 *
 * The reduction is deterministic and never guesses: a compatibility
 * decomposition (NFKD) separates accents from their letters and the accents
 * are dropped ("Béton Québec" → "Beton Quebec"); the few Latin letters with
 * no decomposition take their conventional spelling (ß → ss, Æ → AE, Ø → O,
 * Ł → L); typographic quotes and dashes become their ASCII forms. Anything
 * else — CJK, Cyrillic, emoji, control characters — has no faithful ASCII
 * spelling and is refused by name rather than blanked or replaced.
 */
const LETTER_FOLDS: Readonly<Record<string, string>> = {
  "ß": "ss", "ẞ": "SS", "Æ": "AE", "æ": "ae", "Œ": "OE", "œ": "oe",
  "Ø": "O", "ø": "o", "Đ": "D", "đ": "d", "Ð": "D", "ð": "d",
  "Ł": "L", "ł": "l", "Þ": "TH", "þ": "th", "ı": "i", "Ħ": "H", "ħ": "h",
  "‘": "'", "’": "'", "‚": "'", "“": "\"", "”": "\"", "„": "\"",
  "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-",
};

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
const COMBINING_MARKS = /[\u0300-\u036f]/g;

/** Every character printable ASCII (space through tilde) — no controls, no line breaks. */
export function isPrintableAscii(value: string): boolean {
  return PRINTABLE_ASCII.test(value);
}

/**
 * Fold `value` to printable ASCII, or report the first character (as typed)
 * that has no ASCII spelling.
 */
export function foldToAscii(value: string): { ok: true; text: string } | { ok: false; character: string } {
  let text = "";
  for (const character of value) {
    const folded = LETTER_FOLDS[character] ?? character.normalize("NFKD").replace(COMBINING_MARKS, "");
    if (!isPrintableAscii(folded)) return { ok: false, character };
    text += folded;
  }
  return { ok: true, text };
}

/** Where the operator corrects a refused value. */
export const PAYEE_NAME_REMEDY =
  "Edit the payee's name to Latin letters without that character, then generate the file again.";
export const ORIGINATOR_REMEDY =
  "Edit the originator details on the payment bank profile to Latin letters, then generate the file again.";

/**
 * `value` folded to printable ASCII for a fixed-width `rail` field, or a
 * PaymentError naming the rail, the field, the value, the offending character
 * and where to correct it.
 */
export function asciiRailText(value: string, rail: string, field: string, remedy: string): string {
  const folded = foldToAscii(value);
  if (folded.ok) return folded.text;
  throw new PaymentError(
    `${rail} ${field} "${value}" contains "${folded.character}", which has no ASCII spelling — ` +
      `${rail} records are fixed-width ASCII and it would shift every field after it. ${remedy}`,
  );
}

/**
 * Refuse a rendered bank file whose bytes would not match its declared
 * us-ascii charset: the last line of defence for any writer (a custom
 * formatter, a register) that did not fold its text itself. Names the line
 * so the operator can find the record.
 */
export function assertDeclaredAsciiCharset(contentType: string, content: string): void {
  if (!/charset\s*=\s*"?us-ascii"?/i.test(contentType)) return;
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (isPrintableAscii(line)) continue;
    const character = [...line].find((c) => !isPrintableAscii(c))!;
    throw new PaymentError(
      `payment file line ${index + 1} contains "${character}", which is not ASCII, but the file is declared us-ascii ` +
        `and its fixed-width fields would shift. Edit the payee or originator text on that record to Latin letters without that character, then generate the file again.`,
    );
  }
}

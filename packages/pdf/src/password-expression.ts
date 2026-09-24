/**
 * Password expressions — the tenant-configurable rule that derives a PDF's
 * open password from the record it belongs to.
 *
 * Employers who email pay stubs publish a rule to their staff out of band
 * ("your password is the first three letters of your surname followed by your
 * date of birth"), so the rule has to be CONFIGURATION, not a hardcode. It is
 * also handled entirely server-side over confidential data, which is why this
 * is a closed token substituter and deliberately NOT an expression language:
 * there is no arithmetic, no comparison, no function call, no property access,
 * and no way to reference anything the caller did not put in `values`.
 *
 * Grammar (everything outside braces is a literal):
 *
 *   {token}            the whole value
 *   {token:3}          text tokens — the first 3 characters
 *   {token:MMDDYYYY}   date tokens — one of the allowed formats
 *   {token|upper}      optional case modifier (upper | lower)
 *   {{ }}              literal braces
 *
 * Every failure throws: an unknown token, an unknown format, a text length
 * outside 1–64, an unknown modifier, or a value the record does not carry. A
 * silently-empty component would quietly weaken every password produced from
 * it, so this never degrades.
 */

export class PasswordExpressionError extends Error {}

/**
 * Minimum strength of a derived PDF open password. A stub password guards
 * emailed wage data, so a rule that can produce a 1-character credential
 * ('last 1' of a name) is refused: the derivation must reach this length AND
 * mix letters with digits, both when the rule is saved and when a password
 * is derived from a real record.
 */
export const MIN_DERIVED_PASSWORD_LENGTH = 8;

export type PasswordTokenKind = "text" | "date";

/** token name → kind. The caller owns the vocabulary; this module owns the grammar. */
export type PasswordTokenCatalog = Record<string, PasswordTokenKind>;

/** ISO (yyyy-mm-dd) date, rendered into one of the allowed date layouts. */
const DATE_FORMATS: Record<string, (parts: { y: string; m: string; d: string }) => string> = {
  MMDDYYYY: (p) => `${p.m}${p.d}${p.y}`,
  DDMMYYYY: (p) => `${p.d}${p.m}${p.y}`,
  YYYYMMDD: (p) => `${p.y}${p.m}${p.d}`,
  MMDDYY: (p) => `${p.m}${p.d}${p.y.slice(2)}`,
  DDMMYY: (p) => `${p.d}${p.m}${p.y.slice(2)}`,
  YYMMDD: (p) => `${p.y.slice(2)}${p.m}${p.d}`,
  MMDD: (p) => `${p.m}${p.d}`,
  YYYY: (p) => p.y,
};

export const PASSWORD_DATE_FORMATS = Object.keys(DATE_FORMATS);

const MODIFIERS = new Set(["upper", "lower"]);

interface TokenSegment {
  kind: "token";
  token: string;
  /** Text: character count. Date: format key. Absent = the whole value. */
  argument: string | null;
  modifier: string | null;
}

type Segment = { kind: "literal"; text: string } | TokenSegment;

/**
 * Parse and validate an expression against a token catalog WITHOUT any record
 * data — this is what a settings screen calls to refuse a bad rule at save
 * time rather than at stub-email time.
 */
export function parsePasswordExpression(
  expression: string,
  catalog: PasswordTokenCatalog,
): Segment[] {
  if (expression.length > 200) throw new PasswordExpressionError("password expression is too long");
  const segments: Segment[] = [];
  let literal = "";
  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index]!;
    if (char === "{" && expression[index + 1] === "{") {
      literal += "{";
      index += 1;
      continue;
    }
    if (char === "}" && expression[index + 1] === "}") {
      literal += "}";
      index += 1;
      continue;
    }
    if (char === "}") throw new PasswordExpressionError("unbalanced } in the password expression");
    if (char !== "{") {
      literal += char;
      continue;
    }
    const end = expression.indexOf("}", index);
    if (end === -1) throw new PasswordExpressionError("unbalanced { in the password expression");
    if (literal) {
      segments.push({ kind: "literal", text: literal });
      literal = "";
    }
    segments.push(parseToken(expression.slice(index + 1, end), catalog));
    index = end;
  }
  if (literal) segments.push({ kind: "literal", text: literal });
  if (segments.every((segment) => segment.kind === "literal")) {
    throw new PasswordExpressionError("the password expression uses no record values");
  }
  assertPasswordStrength(segments, catalog);
  return segments;
}

/**
 * Save-time strength floor: refuse a rule whose SHORTEST derivable password
 * is below the minimum, or that cannot mix letters with digits at all (a
 * date-only rule derives digits forever). Derive-time re-checks the actual
 * credential, since a structurally sound rule can still meet a short name.
 */
function assertPasswordStrength(segments: Segment[], catalog: PasswordTokenCatalog): void {
  let floor = 0;
  let canYieldLetter = false;
  let canYieldDigit = false;
  for (const segment of segments) {
    if (segment.kind === "literal") {
      floor += segment.text.length;
      if (/[A-Za-z]/.test(segment.text)) canYieldLetter = true;
      if (/[0-9]/.test(segment.text)) canYieldDigit = true;
      continue;
    }
    if (catalog[segment.token] === "date") {
      // A date renders a fixed layout (MMDDYYYY is 8, MMDD is 4); measure a
      // representative value so new layouts are covered without a table.
      floor += DATE_FORMATS[segment.argument!]!({ y: "2000", m: "01", d: "02" }).length;
      canYieldDigit = true;
    } else {
      // A text component always yields at least one usable character (an
      // empty one throws at derive time) and cleans to letters or digits.
      floor += 1;
      canYieldLetter = true;
      canYieldDigit = true;
    }
  }
  if (floor < MIN_DERIVED_PASSWORD_LENGTH) {
    throw new PasswordExpressionError(
      `the password expression can derive passwords as short as ${floor} characters (minimum ${MIN_DERIVED_PASSWORD_LENGTH}) — add a longer component, e.g. a date token like {dob:MMDDYYYY}`,
    );
  }
  if (!canYieldLetter || !canYieldDigit) {
    throw new PasswordExpressionError(
      "the password expression must be able to mix letters and digits — combine a text token with a date or numeric component",
    );
  }
}

function parseToken(body: string, catalog: PasswordTokenCatalog): TokenSegment {
  const [head, ...modifierParts] = body.split("|");
  if (modifierParts.length > 1) throw new PasswordExpressionError(`too many modifiers in "${body}"`);
  const modifier = modifierParts[0]?.trim() ?? null;
  if (modifier !== null && !MODIFIERS.has(modifier)) {
    throw new PasswordExpressionError(`unknown modifier "${modifier}" (use upper or lower)`);
  }
  const [rawToken, ...argumentParts] = (head ?? "").split(":");
  const token = (rawToken ?? "").trim();
  if (argumentParts.length > 1) throw new PasswordExpressionError(`too many arguments in "${body}"`);
  const argument = argumentParts.length === 1 ? argumentParts[0]!.trim() : null;
  const kind = catalog[token];
  if (!kind) {
    throw new PasswordExpressionError(
      `unknown token "${token}" — available: ${Object.keys(catalog).sort().join(", ")}`,
    );
  }
  if (kind === "date") {
    if (argument === null) {
      throw new PasswordExpressionError(
        `"${token}" needs a date format, e.g. {${token}:MMDDYYYY}`,
      );
    }
    if (!DATE_FORMATS[argument]) {
      throw new PasswordExpressionError(
        `unknown date format "${argument}" — available: ${PASSWORD_DATE_FORMATS.join(", ")}`,
      );
    }
  } else if (argument !== null) {
    const length = Number(argument);
    if (!Number.isInteger(length) || length < 1 || length > 64) {
      throw new PasswordExpressionError(`"${token}" length must be a whole number from 1 to 64`);
    }
  }
  return { kind: "token", token, argument, modifier };
}

/** Validation-only entry point for settings screens. */
export function assertValidPasswordExpression(
  expression: string,
  catalog: PasswordTokenCatalog,
): void {
  parsePasswordExpression(expression, catalog);
}

/**
 * Render an expression against one record's values.
 *
 * SECURITY: the result is a live credential. Callers must pass it straight to
 * the encryptor — never log it, never persist it, never return it to a client.
 */
export function renderPasswordExpression(
  expression: string,
  catalog: PasswordTokenCatalog,
  values: Record<string, string | null | undefined>,
): string {
  const segments = parsePasswordExpression(expression, catalog);
  let out = "";
  for (const segment of segments) {
    if (segment.kind === "literal") {
      out += segment.text;
      continue;
    }
    const raw = values[segment.token];
    if (raw == null || String(raw).trim() === "") {
      throw new PasswordExpressionError(`the record has no value for "${segment.token}"`);
    }
    out += renderToken(segment, catalog[segment.token]!, String(raw));
  }
  if (out.length === 0) throw new PasswordExpressionError("the password expression produced nothing");
  // Length needs no second check here: the save-time floor lower-bounds every
  // derivation (each component yields at least its counted minimum), so a
  // rule that passed saving always derives at least the minimum — including
  // legacy rules, which re-parse (and re-check) on every render. The mix is
  // re-checked because structure cannot guarantee it: a text token assumed
  // alphanumeric can meet an all-digit value like an employee number.
  if (!/[A-Za-z]/.test(out) || !/[0-9]/.test(out)) {
    throw new PasswordExpressionError(
      "the derived password must mix letters and digits — use a rule combining a text token with a date or numeric component",
    );
  }
  return out;
}

function renderToken(segment: TokenSegment, kind: PasswordTokenKind, raw: string): string {
  let value: string;
  if (kind === "date") {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw.trim());
    if (!match) throw new PasswordExpressionError(`"${segment.token}" is not a date`);
    value = DATE_FORMATS[segment.argument!]!({ y: match[1]!, m: match[2]!, d: match[3]! });
  } else {
    // Diacritics and punctuation are dropped so a name types the same way the
    // employer's published rule reads it ("O'Brien" → OBrien).
    const clean = raw.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9]/g, "");
    if (clean === "") throw new PasswordExpressionError(`"${segment.token}" has no usable characters`);
    value = segment.argument === null ? clean : clean.slice(0, Number(segment.argument));
  }
  if (segment.modifier === "upper") return value.toUpperCase();
  if (segment.modifier === "lower") return value.toLowerCase();
  return value;
}

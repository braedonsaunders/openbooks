/**
 * Catalog-backed refusals.
 *
 * A domain refusal names a catalog key and the typed figures its sentence
 * carries; the application renders the message and remedy from the locale
 * catalogs (`refusals.<module>.<key>.message|remedy` in web/messages) in the
 * reader's language, with every figure formatted for the reader: share
 * counts grouped and plural-selected, amounts in their currency, prices per
 * share under the four-place rule, dates as medium civil dates, periods by
 * their fiscal label and months, and field names from the same catalog keys
 * as the form labels. The engine keeps an English rendering of the same
 * templates for logs and for callers that have no reader.
 *
 * Templates are ICU messages. A plain `{name}` is the formatted figure; a
 * share or count figure also selects plural forms as `{nameCount, plural,
 * one {…} other {…}}`, and a choice figure selects wording as `{name,
 * select, … other {…}}`. Figures stay exact: plural selection reads a
 * number, while the digits shown always come from the exact value.
 */
import { civilDateLabel } from "./civil-date-labels.ts";
import { perShareFractionDigits as perSharePlaces } from "@openbooks/reports/per-share";
export { perShareFractionDigits as perSharePlaces } from "@openbooks/reports/per-share";

/** A figure a refusal names. */
export type RefusalValue =
  /** A share count (whole, or an exact decimal for fractional units). */
  | { kind: "shares"; value: bigint | string }
  /** Any other whole count: characters, days, months, records. */
  | { kind: "count"; value: bigint | number | string }
  | { kind: "money"; value: string; currency: string }
  /** A price per share: four places, more only where four would read as zero. */
  | { kind: "price"; value: string; currency: string | null }
  /** A plain exact decimal. */
  | { kind: "decimal"; value: string }
  /** A multiple, such as a liquidation preference of 0.5×. */
  | { kind: "multiple"; value: string }
  /** A percentage stated in percent units (`20` is 20 %). */
  | { kind: "percent"; value: string }
  | { kind: "date"; value: string }
  /** An accounting period: its canonical fiscal label and the months it spans. */
  | { kind: "period"; label: string; startsOn: string | null; endsOn: string | null }
  /** Text recorded by a person (a security number, a class code, a name), shown as written. */
  | { kind: "text"; value: string }
  /** Recorded texts read as one list. */
  | { kind: "list"; value: readonly string[] }
  /** A stable value the template selects its wording by (`{name, select, …}`). */
  | { kind: "choice"; value: string }
  /** A catalog term (a field label, a named concept), with its English text for the engine's own rendering. */
  | { kind: "term"; key: string; text: string };

export type RefusalValueKind = RefusalValue["kind"];

/** The figures of one refusal, by template argument. */
export type RefusalValues = Readonly<Record<string, RefusalValue>>;

/** One catalog entry: its stable code, English templates and the figures they take. */
export interface RefusalSpec {
  readonly code: string;
  readonly message: string;
  readonly remedy: string;
  readonly params?: Readonly<Record<string, RefusalValueKind>>;
}

/** The contract a catalog-backed refusal exposes to the application. */
export interface CatalogRefusal {
  readonly code: string;
  /** `<module>.<key>`: the entry under `refusals` in the locale catalogs. */
  readonly catalogKey: string;
  readonly values: RefusalValues;
  /** The English rendering, for logs and callers without a reader. */
  readonly message: string;
  readonly remedy: string;
}

/** A refusal's figures as plain data (bigints as digit strings), safe to hand to a view or serialize. */
export function serializeRefusalValues(values: RefusalValues): Record<string, RefusalValue> {
  const out: Record<string, RefusalValue> = {};
  for (const [name, value] of Object.entries(values)) {
    out[name] =
      value.kind === "shares" || value.kind === "count"
        ? { ...value, value: String(value.value) }
        : value;
  }
  return out;
}

/** A catalog-backed refusal as plain data, or null for anything else. */
export function catalogRefusalOf(error: unknown): CatalogRefusal | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as Partial<CatalogRefusal>;
  if (
    typeof candidate.catalogKey !== "string" ||
    typeof candidate.code !== "string" ||
    typeof candidate.message !== "string" ||
    typeof candidate.remedy !== "string"
  )
    return null;
  return {
    code: candidate.code,
    catalogKey: candidate.catalogKey,
    values: serializeRefusalValues(candidate.values ?? {}),
    message: candidate.message,
    remedy: candidate.remedy,
  };
}

const DEFAULT_LOCALE = "en-US";

function groupedInteger(digits: string, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(BigInt(digits));
}

const DECIMAL = /^(-)?(\d+)(?:\.(\d+))?$/;

/** Round a plain decimal string half up to `scale` places, exactly. */
function roundDecimal(
  value: string,
  scale: number,
): { negative: boolean; whole: string; fraction: string } | null {
  const match = DECIMAL.exec(value.trim());
  if (!match) return null;
  const fraction = match[3] ?? "";
  let units = BigInt(`${match[2]}${fraction.padEnd(scale, "0").slice(0, scale)}`);
  if (fraction.length > scale && fraction[scale]! >= "5") units += 1n;
  const text = units.toString().padStart(scale + 1, "0");
  return {
    negative: match[1] === "-" && units !== 0n,
    whole: scale > 0 ? text.slice(0, -scale) : text,
    fraction: scale > 0 ? text.slice(-scale) : "",
  };
}

function decimalSeparator(locale: string): string {
  return (
    new Intl.NumberFormat(locale).formatToParts(1.5).find((part) => part.type === "decimal")
      ?.value ?? "."
  );
}

/** An exact decimal in the locale's digits and separators, trailing zeros trimmed. */
function localDecimal(value: string, locale: string): string {
  const match = DECIMAL.exec(value.trim());
  if (!match) return value;
  const fraction = (match[3] ?? "").replace(/0+$/, "");
  const sign = match[1] && (/[1-9]/.test(match[2]!) || fraction !== "") ? "-" : "";
  return `${sign}${groupedInteger(match[2]!, locale)}${fraction ? `${decimalSeparator(locale)}${fraction}` : ""}`;
}

/** A number placed in a locale's template for a style (currency or percent), the digits exact. */
function inTemplate(
  digits: { negative: boolean; whole: string; fraction: string },
  locale: string,
  options: Intl.NumberFormatOptions,
): string | null {
  let template: Intl.NumberFormat;
  try {
    template = new Intl.NumberFormat(locale, options);
  } catch {
    return null;
  }
  const parts = template.formatToParts(digits.negative ? -1 : 1);
  const numeric = (part: Intl.NumberFormatPart) =>
    part.type === "integer" ||
    part.type === "group" ||
    part.type === "decimal" ||
    part.type === "fraction";
  const first = parts.findIndex(numeric);
  let last = -1;
  parts.forEach((part, index) => {
    if (numeric(part)) last = index;
  });
  if (first < 0) return null;
  const number = `${groupedInteger(digits.whole, locale)}${digits.fraction ? `${decimalSeparator(locale)}${digits.fraction}` : ""}`;
  return [
    ...parts.slice(0, first).map((part) => part.value),
    number,
    ...parts.slice(last + 1).map((part) => part.value),
  ].join("");
}

function currencyAmount(value: string, currency: string, locale: string, places?: number): string {
  let scale = places;
  if (scale === undefined) {
    try {
      scale =
        new Intl.NumberFormat(locale, { style: "currency", currency }).resolvedOptions()
          .maximumFractionDigits ?? 2;
    } catch {
      return `${value} ${currency}`;
    }
  }
  const rounded = roundDecimal(value, scale);
  if (!rounded) return `${value} ${currency}`;
  return (
    inTemplate(rounded, locale, {
      style: "currency",
      currency,
      minimumFractionDigits: scale,
      maximumFractionDigits: scale,
    }) ?? `${value} ${currency}`
  );
}

/**
 * A civil date as a medium date in the locale (the form every date in the
 * product reads in), from its own year, month and day, so no server time
 * zone moves the day. An impossible date is left as written.
 */
export function formatRefusalDate(isoDate: string, locale: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return isoDate;
  const instant = new Date(`${isoDate}T12:00:00Z`);
  if (Number.isNaN(instant.getTime()) || instant.toISOString().slice(0, 10) !== isoDate)
    return isoDate;
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(instant);
}

/** Resolves a catalog term in the reader's language; the engine's own rendering uses its English text. */
export type TermResolver = (key: string, text: string) => string;

/** One refusal figure in a locale. */
export function formatRefusalValue(
  value: RefusalValue,
  locale: string,
  term: TermResolver = (_key, text) => text,
): string {
  switch (value.kind) {
    case "shares":
    case "count": {
      const text = String(value.value);
      if (/^-?\d+$/.test(text))
        return text.startsWith("-")
          ? `-${groupedInteger(text.slice(1), locale)}`
          : groupedInteger(text, locale);
      return localDecimal(text, locale);
    }
    case "money":
      return currencyAmount(value.value, value.currency, locale);
    case "price":
      return value.currency
        ? currencyAmount(value.value, value.currency, locale, perSharePlaces(value.value))
        : (() => {
            const rounded = roundDecimal(value.value, perSharePlaces(value.value));
            return rounded
              ? `${rounded.negative ? "-" : ""}${groupedInteger(rounded.whole, locale)}${rounded.fraction ? `${decimalSeparator(locale)}${rounded.fraction}` : ""}`
              : value.value;
          })();
    case "decimal":
      return localDecimal(value.value, locale);
    case "multiple":
      return `${localDecimal(value.value, locale)}×`;
    case "percent": {
      const match = DECIMAL.exec(value.value.trim());
      if (!match) return value.value;
      const fraction = (match[3] ?? "").replace(/0+$/, "");
      return (
        inTemplate({ negative: match[1] === "-", whole: match[2]!, fraction }, locale, {
          style: "percent",
        }) ?? `${value.value}%`
      );
    }
    case "date":
      return formatRefusalDate(value.value, locale);
    case "period": {
      if (!value.startsOn || !value.endsOn) return value.label;
      const first = civilDateLabel(value.startsOn, locale, "monthYear");
      const last = civilDateLabel(value.endsOn, locale, "monthYear");
      return `${value.label} · ${first === last ? first : `${first} – ${last}`}`;
    }
    case "text":
    case "choice":
      return value.value;
    case "list":
      return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(
        value.value,
      );
    case "term":
      return term(value.key, value.text);
  }
}

/** The number a share or count figure selects plural forms by (its category only; the digits shown stay exact). */
function pluralNumber(value: RefusalValue): number | null {
  if (value.kind !== "shares" && value.kind !== "count") return null;
  const number = Number(String(value.value));
  return Number.isFinite(number) ? number : null;
}

/**
 * The template arguments for a refusal's figures in a locale: each figure
 * formatted under its name, and each share or count figure's number under
 * `<name>Count` for plural selection.
 */
export function refusalArguments(
  values: RefusalValues,
  locale: string,
  term?: TermResolver,
): Record<string, string | number> {
  const args: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(values)) {
    args[name] = formatRefusalValue(value, locale, term);
    const count = pluralNumber(value);
    if (count !== null) args[`${name}Count`] = count;
  }
  return args;
}

function closingBrace(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** The `selector {message}` branches of a plural or select argument. */
function branches(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let index = 0;
  while (index < text.length) {
    while (index < text.length && /\s/.test(text[index]!)) index += 1;
    const open = text.indexOf("{", index);
    if (open < 0) break;
    const selector = text.slice(index, open).trim();
    const close = closingBrace(text, open);
    if (close < 0) break;
    out.set(selector, text.slice(open + 1, close));
    index = close + 1;
  }
  return out;
}

function renderArgument(
  inner: string,
  args: Readonly<Record<string, string | number>>,
  locale: string,
): string {
  const comma = inner.indexOf(",");
  const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
  if (comma < 0) return name in args ? String(args[name]) : `{${inner}}`;
  const rest = inner.slice(comma + 1);
  const second = rest.indexOf(",");
  const type = (second < 0 ? rest : rest.slice(0, second)).trim();
  const options = branches(second < 0 ? "" : rest.slice(second + 1));
  const value = args[name];
  if (type === "plural") {
    const number = typeof value === "number" ? value : Number(value);
    const exact = options.get(`=${number}`);
    const category = Number.isFinite(number)
      ? new Intl.PluralRules(locale).select(number)
      : "other";
    const chosen = exact ?? options.get(category) ?? options.get("other") ?? "";
    const base = name.endsWith("Count") ? name.slice(0, -"Count".length) : null;
    const pound =
      base && base in args
        ? String(args[base])
        : Number.isFinite(number)
          ? new Intl.NumberFormat(locale).format(number)
          : String(value);
    return renderTemplate(chosen, args, locale, pound);
  }
  if (type === "select")
    return renderTemplate(options.get(String(value)) ?? options.get("other") ?? "", args, locale);
  return value === undefined ? `{${inner}}` : String(value);
}

/**
 * Render an ICU message template: `{name}` arguments, `plural` and `select`
 * arguments with nested messages, `#` inside a plural branch and `''` for a
 * literal apostrophe. An argument with no value stays as written.
 */
export function renderTemplate(
  template: string,
  args: Readonly<Record<string, string | number>>,
  locale: string,
  pound?: string,
): string {
  let out = "";
  let index = 0;
  while (index < template.length) {
    const char = template[index]!;
    if (char === "{") {
      const close = closingBrace(template, index);
      if (close < 0) {
        out += template.slice(index);
        break;
      }
      out += renderArgument(template.slice(index + 1, close), args, locale);
      index = close + 1;
      continue;
    }
    if (char === "#" && pound !== undefined) {
      out += pound;
      index += 1;
      continue;
    }
    if (char === "'" && template[index + 1] === "'") {
      out += "'";
      index += 2;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/** A refusal template rendered with its figures, in English unless a locale is named. */
export function renderRefusal(
  template: string,
  values: RefusalValues,
  locale = DEFAULT_LOCALE,
  term?: TermResolver,
): string {
  return renderTemplate(template, refusalArguments(values, locale, term), locale);
}

/** The named refusal every equity command, read and model raises. */
export type EquityErrorStatus = 403 | 404 | 409 | 422;

/**
 * A figure a refusal names. The message and remedy carry `{name}`
 * placeholders; each figure is rendered in the reader's locale (grouped
 * digits, the currency's symbol and minor unit) without crossing binary
 * floating point.
 */
export type RefusalValue =
  | { kind: "shares"; value: bigint | string }
  | { kind: "money"; value: string; currency: string }
  | { kind: "decimal"; value: string }
  | { kind: "date"; value: string };

/** The locale the refusal's own message and remedy are rendered in for logs and callers without a reader. */
const DEFAULT_REFUSAL_LOCALE = "en-US";

function groupedInteger(digits: string, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(BigInt(digits));
}

/** Round a plain decimal string half up to `scale` places, exactly. */
function roundDecimal(value: string, scale: number): { negative: boolean; whole: string; fraction: string } {
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return { negative: false, whole: value, fraction: "" };
  const negative = match[1] === "-";
  const fraction = match[3] ?? "";
  let units = BigInt(`${match[2]}${fraction.padEnd(scale, "0").slice(0, scale)}`);
  if (fraction.length > scale && fraction[scale]! >= "5") units += 1n;
  const text = units.toString().padStart(scale + 1, "0");
  return { negative: negative && units !== 0n, whole: scale > 0 ? text.slice(0, -scale) : text, fraction: scale > 0 ? text.slice(-scale) : "" };
}

/** A civil YYYY-MM-DD date read whole: anything else (an entry number such as EQ-SBC-2026-12-31, a period key) is left as written. */
const CIVIL_DATE_IN_TEXT = /(?<![\w-])(\d{4})-(\d{2})-(\d{2})(?![\w-])/g;

/**
 * A civil date as a medium date in the locale (the form every date in the
 * product reads in), from its own year, month and day at UTC noon so no
 * server time zone moves the day. An impossible date is left as written.
 */
export function formatRefusalDate(isoDate: string, locale: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return isoDate;
  const instant = new Date(`${isoDate}T12:00:00Z`);
  if (Number.isNaN(instant.getTime()) || instant.toISOString().slice(0, 10) !== isoDate) return isoDate;
  return new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).format(instant);
}

/** Every civil date written into a refusal's text, in the locale. */
export function localizeRefusalDates(text: string, locale: string): string {
  return text.replace(CIVIL_DATE_IN_TEXT, (whole) => formatRefusalDate(whole, locale));
}

/** One refusal figure in a locale. */
export function formatRefusalValue(value: RefusalValue, locale: string): string {
  if (value.kind === "date") return formatRefusalDate(value.value, locale);
  if (value.kind === "shares") {
    const text = String(value.value);
    if (!/^-?\d+$/.test(text)) return text;
    return text.startsWith("-") ? `-${groupedInteger(text.slice(1), locale)}` : groupedInteger(text, locale);
  }
  if (value.kind === "decimal") {
    const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(value.value.trim());
    if (!match) return value.value;
    const fraction = (match[3] ?? "").replace(/0+$/, "");
    const decimal = new Intl.NumberFormat(locale).formatToParts(1.5).find((part) => part.type === "decimal")?.value ?? ".";
    return `${match[1] ?? ""}${groupedInteger(match[2]!, locale)}${fraction ? `${decimal}${fraction}` : ""}`;
  }
  let template: Intl.NumberFormat;
  try {
    template = new Intl.NumberFormat(locale, { style: "currency", currency: value.currency });
  } catch {
    return `${value.value} ${value.currency}`;
  }
  const scale = template.resolvedOptions().maximumFractionDigits ?? 2;
  const rounded = roundDecimal(value.value, scale);
  const parts = template.formatToParts(rounded.negative ? -1 : 1);
  const numeric = (part: Intl.NumberFormatPart) => part.type === "integer" || part.type === "group" || part.type === "decimal" || part.type === "fraction";
  const first = parts.findIndex(numeric);
  let last = -1;
  parts.forEach((part, index) => {
    if (numeric(part)) last = index;
  });
  if (first < 0) return `${value.value} ${value.currency}`;
  const decimal = parts.find((part) => part.type === "decimal")?.value ?? ".";
  const number = `${groupedInteger(rounded.whole, locale)}${rounded.fraction ? `${decimal}${rounded.fraction}` : ""}`;
  return [...parts.slice(0, first).map((part) => part.value), number, ...parts.slice(last + 1).map((part) => part.value)].join("");
}

/** Replace each `{name}` placeholder with its figure in the locale; unknown placeholders stay as written. */
export function renderRefusal(template: string, values: Readonly<Record<string, RefusalValue>>, locale: string): string {
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (whole, name: string) => (values[name] ? formatRefusalValue(values[name]!, locale) : whole));
}

export class EquityError extends Error {
  readonly name = "EquityError";
  readonly status: EquityErrorStatus;
  readonly code: string;
  readonly remedy: string;
  readonly field?: string;
  /** The figures the message and remedy name, rendered per reader by `localized`. */
  readonly values?: Readonly<Record<string, RefusalValue>>;
  private readonly templates?: { message: string; remedy: string };

  constructor(
    message: string,
    options: { status?: EquityErrorStatus; code?: string; remedy?: string; field?: string; cause?: unknown; values?: Record<string, RefusalValue> } = {},
  ) {
    const remedy = options.remedy ?? "Correct the equity input and submit it again.";
    const values = options.values;
    super(values ? renderRefusal(message, values, DEFAULT_REFUSAL_LOCALE) : message, { cause: options.cause });
    this.status = options.status ?? 422;
    this.code = options.code ?? "equity_invalid";
    this.remedy = values ? renderRefusal(remedy, values, DEFAULT_REFUSAL_LOCALE) : remedy;
    if (options.field !== undefined) this.field = options.field;
    if (values) {
      this.values = values;
      this.templates = { message, remedy };
    }
  }

  /**
   * The message and remedy for a reader: figures in the locale's digits and
   * currency, and every civil date the text names as a date in the locale.
   */
  localized(locale: string): { message: string; remedy: string } {
    const message = this.templates && this.values ? renderRefusal(this.templates.message, this.values, locale) : this.message;
    const remedy = this.templates && this.values ? renderRefusal(this.templates.remedy, this.values, locale) : this.remedy;
    return { message: localizeRefusalDates(message, locale), remedy: localizeRefusalDates(remedy, locale) };
  }
}

export const EQUITY_FEATURE_KEY = "equity";

export const EQUITY_FEATURE_REMEDY = "Turn on Equity & cap table in Company Settings → Features.";

/** Where the effective-dated equity account policy is maintained. */
export const EQUITY_ACCOUNTS_REMEDY =
  "Add an equity account policy for the legal entity, effective on or before the transaction date (Setup → Equity accounts).";

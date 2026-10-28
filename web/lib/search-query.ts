import {
  addCalendarDays,
  addMonthsStart,
  civilDateFromParts,
  daysInCivilMonth,
  endOfMonth,
  mondayOfIsoWeek,
  startOfMonth,
} from "@openbooks/engine/platform/civil-date";

/**
 * Header-search query understanding.
 *
 * A query is read left to right into constraints that a record must all
 * satisfy: words, an amount, a date range, a lifecycle status and a record
 * scope. Plain language reads naturally — "invoices over 1,000 from acme this
 * year" is an invoice scope, an amount above 1,000.00, the word "acme" and
 * the current calendar year — and the same structure answers prefix syntax
 * (`inv:3668`), operators (`>5000`, `100..250`) and dates (`2026-04-15`,
 * `last month`, `Q3`).
 *
 * The reading is deterministic: the same text, vocabulary and day always
 * produce the same constraints. Every recognized constraint is reported as a
 * chip naming the exact characters it came from, so the reader sees what
 * was understood and can remove any part of it; quoting text keeps it
 * literal. Amounts never pass through floating point: they are whole cents
 * as decimal strings.
 */

export const SEARCH_SCOPES = [
  "invoice",
  "credit",
  "bill",
  "vendorCredit",
  "purchaseOrder",
  "quote",
  "salesOrder",
  "cashSale",
  "refund",
  "payment",
  "receipt",
  "check",
  "deposit",
  "transfer",
  "cardCharge",
  "expense",
  "fieldTicket",
  "journal",
  "payRun",
  "shipment",
  "pick",
  "customer",
  "vendor",
  "employee",
  "contact",
  "item",
  "project",
  "account",
] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];

export const SEARCH_STATUSES = [
  "open",
  "overdue",
  "paid",
  "draft",
  "pending",
  "voided",
  "posted",
] as const;
export type SearchStatus = (typeof SEARCH_STATUSES)[number];

/** Document kinds each transaction scope reads; party, item, project and account scopes name a group. */
export const SCOPE_KINDS: Partial<Record<SearchScope, readonly string[]>> = {
  invoice: ["customer_invoice"],
  credit: ["customer_credit", "vendor_credit"],
  bill: ["vendor_bill"],
  vendorCredit: ["vendor_credit"],
  purchaseOrder: ["purchase_order"],
  quote: ["quote"],
  salesOrder: ["sales_order"],
  cashSale: ["cash_sale"],
  refund: ["cash_refund", "card_refund"],
  payment: ["vendor_payment", "customer_payment"],
  receipt: ["customer_payment"],
  check: ["check"],
  deposit: ["deposit"],
  transfer: ["transfer"],
  cardCharge: ["card_charge", "card_refund"],
  expense: ["expense_report"],
  fieldTicket: ["field_ticket"],
  journal: ["journal"],
  payRun: ["pay_run"],
  shipment: ["shipment"],
  pick: ["pick_list"],
};

/** The record group a scope restricts results to. */
export type SearchScopeGroup = "transaction" | "contact" | "item" | "project" | "account";

export function scopeGroup(scope: SearchScope): SearchScopeGroup {
  if (SCOPE_KINDS[scope]) return "transaction";
  if (scope === "customer" || scope === "vendor" || scope === "employee" || scope === "contact")
    return "contact";
  if (scope === "item" || scope === "project" || scope === "account") return scope;
  return "transaction";
}

/**
 * Words a locale reads as structure. Each list holds lowercase phrases
 * (multi-word phrases allowed). English is always understood beside the
 * reader's own language, since people type English record names in every
 * locale.
 */
export interface SearchVocabulary {
  scopes: Partial<Record<SearchScope, string[]>>;
  statuses: Partial<Record<SearchStatus, string[]>>;
  greater: string[];
  greaterOrEqual: string[];
  less: string[];
  lessOrEqual: string[];
  between: string[];
  and: string[];
  approximately: string[];
  since: string[];
  before: string[];
  through: string[];
  during: string[];
  today: string[];
  yesterday: string[];
  tomorrow: string[];
  thisPeriod: string[];
  lastPeriod: string[];
  nextPeriod: string[];
  pastPeriod: string[];
  day: string[];
  week: string[];
  month: string[];
  quarter: string[];
  year: string[];
  yearToDate: string[];
  monthToDate: string[];
  quarterToDate: string[];
  /** Month names, January first; usually derived from Intl for the locale. */
  months: string[][];
  stopwords: string[];
}

export const ENGLISH_SEARCH_VOCABULARY: SearchVocabulary = {
  scopes: {
    invoice: ["invoice", "invoices", "inv"],
    credit: ["credit", "credits", "credit memo", "credit memos", "credit note", "credit notes"],
    bill: ["bill", "bills", "vendor bill", "vendor bills"],
    vendorCredit: ["vendor credit", "vendor credits"],
    purchaseOrder: ["purchase order", "purchase orders", "po", "pos"],
    quote: ["quote", "quotes", "estimate", "estimates", "est"],
    salesOrder: ["sales order", "sales orders", "so"],
    cashSale: ["cash sale", "cash sales"],
    refund: ["refund", "refunds"],
    payment: ["payment", "payments", "pmt", "bill payment", "bill payments"],
    receipt: ["receipt", "receipts", "customer payment", "customer payments"],
    check: ["check", "checks", "cheque", "cheques", "chk"],
    deposit: ["deposit", "deposits", "dep"],
    transfer: ["transfer", "transfers"],
    cardCharge: ["card charge", "card charges", "card transaction", "card transactions"],
    expense: ["expense", "expenses", "expense report", "expense reports", "exp"],
    fieldTicket: ["field ticket", "field tickets", "ticket", "tickets"],
    journal: ["journal", "journals", "journal entry", "journal entries", "je", "jes"],
    payRun: ["pay run", "pay runs", "payroll"],
    shipment: ["shipment", "shipments"],
    pick: ["pick", "picks", "pick list", "pick lists"],
    customer: ["customer", "customers", "cust"],
    vendor: ["vendor", "vendors", "supplier", "suppliers", "vend"],
    employee: ["employee", "employees", "emp"],
    contact: ["contact", "contacts"],
    item: ["item", "items", "product", "products"],
    project: ["project", "projects", "job", "jobs"],
    account: ["account", "accounts", "gl account", "gl accounts", "acct"],
  },
  statuses: {
    open: ["open", "unpaid", "outstanding", "due"],
    overdue: ["overdue", "past due", "late"],
    paid: ["paid", "settled", "closed"],
    draft: ["draft", "drafts", "unposted"],
    pending: ["pending", "pending approval", "awaiting approval", "for approval"],
    voided: ["void", "voided", "voids"],
    posted: ["posted"],
  },
  greater: ["over", "above", "more than", "greater than", "exceeding", ">"],
  greaterOrEqual: ["at least", ">="],
  less: ["under", "below", "less than", "<"],
  lessOrEqual: ["at most", "up to", "<="],
  between: ["between"],
  and: ["and", "to", "-", ".."],
  approximately: ["about", "around", "approximately", "approx", "roughly", "~"],
  since: ["since", "after", "from"],
  before: ["before", "until", "till", "prior to"],
  through: ["to", "through", "thru", "until", "-"],
  during: ["in", "during", "on"],
  today: ["today"],
  yesterday: ["yesterday"],
  tomorrow: ["tomorrow"],
  thisPeriod: ["this", "current"],
  lastPeriod: ["last", "previous", "prior"],
  nextPeriod: ["next"],
  pastPeriod: ["past", "last"],
  day: ["day", "days"],
  week: ["week", "weeks"],
  month: ["month", "months"],
  quarter: ["quarter", "quarters"],
  year: ["year", "years"],
  yearToDate: ["ytd", "year to date"],
  monthToDate: ["mtd", "month to date"],
  quarterToDate: ["qtd", "quarter to date"],
  months: [],
  stopwords: [
    "from",
    "for",
    "with",
    "the",
    "a",
    "an",
    "of",
    "by",
    "all",
    "show",
    "find",
    "me",
    "my",
    "to",
    "in",
    "on",
    "at",
    "and",
  ],
};

/** Month names for a locale, long and short, lowercase, January first. */
export function localeMonthNames(locale: string): string[][] {
  const long = new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" });
  const short = new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" });
  return Array.from({ length: 12 }, (_, index) => {
    const date = new Date(0);
    date.setUTCFullYear(2001, index, 15);
    const names = new Set(
      [long.format(date), short.format(date)].map((name) => name.toLowerCase().replace(/\.$/, "")),
    );
    return [...names];
  });
}

const ENGLISH_MONTHS = localeMonthNames("en").map((names) =>
  names[0] === "september" ? [...names, "sept"] : names,
);

/** Merge the reader's locale vocabulary over English; both are understood. */
export function mergeVocabulary(
  local: Partial<SearchVocabulary> | null,
  localeMonths: string[][] | null,
): SearchVocabulary {
  const list = (a: string[] | undefined, b: string[]) => [...new Set([...(a ?? []), ...b])];
  const base = ENGLISH_SEARCH_VOCABULARY;
  const merged: SearchVocabulary = { ...base, scopes: {}, statuses: {} };
  for (const scope of SEARCH_SCOPES)
    merged.scopes[scope] = list(local?.scopes?.[scope], base.scopes[scope] ?? []);
  for (const status of SEARCH_STATUSES)
    merged.statuses[status] = list(local?.statuses?.[status], base.statuses[status] ?? []);
  for (const key of Object.keys(base) as (keyof SearchVocabulary)[]) {
    if (key === "scopes" || key === "statuses" || key === "months") continue;
    (merged as unknown as Record<string, string[]>)[key] = list(
      (local as Record<string, string[] | undefined> | null)?.[key],
      base[key] as string[],
    );
  }
  merged.months = ENGLISH_MONTHS.map((names, index) => list(localeMonths?.[index], names));
  return merged;
}

/** An amount bound in whole cents (a non-negative integer as decimal digits). */
export interface CentsRange {
  min: string;
  max: string | null;
}

export type SearchChip =
  | { kind: "scope"; scope: SearchScope; start: number; end: number }
  | { kind: "status"; status: SearchStatus; start: number; end: number }
  | {
      kind: "amount";
      min: string;
      max: string | null;
      approximate: boolean;
      start: number;
      end: number;
    }
  | { kind: "date"; from: string | null; to: string | null; start: number; end: number };

/** One word the record must contain. */
export interface SearchWord {
  /** The lowercased word as typed. */
  text: string;
  /** Its index terms: the word itself, or its letter and digit runs. */
  terms: string[];
  /** Quoted words match whole terms only. */
  exact: boolean;
  /** A bare number also reads as an amount starting with those digits. */
  amount: CentsRange | null;
}

export interface ParsedSearch {
  /** The trimmed query. */
  q: string;
  words: SearchWord[];
  amount: (CentsRange & { approximate: boolean }) | null;
  dates: { from: string | null; to: string | null } | null;
  status: SearchStatus | null;
  scopes: SearchScope[];
  chips: SearchChip[];
}

export interface ParseOptions {
  vocabulary: SearchVocabulary;
  /** The organization's business date (YYYY-MM-DD). */
  today: string;
  /** How a numeric date with two ambiguous parts reads: month first or day first. */
  dateOrder: "mdy" | "dmy" | "ymd";
  /** First month (1–12) of the fiscal year, for quarters and FY years. */
  fiscalYearStartMonth: number;
}

type Token = { text: string; lower: string; start: number; end: number; quoted: boolean };

/** Split into tokens with their source spans; quotes group a literal phrase. */
function tokenize(q: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /"([^"]*)"?|\S+/g;
  for (const match of q.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (match[0].startsWith('"')) {
      const inner = match[1] ?? "";
      let offset = 0;
      for (const piece of inner.split(/\s+/)) {
        const at = inner.indexOf(piece, offset);
        offset = at + piece.length;
        if (!piece) continue;
        tokens.push({
          text: piece,
          lower: piece.toLowerCase(),
          start: start + 1 + at,
          end: start + 1 + at + piece.length,
          quoted: true,
        });
      }
      continue;
    }
    // Keep operators attached to what they compare (">5000"), but let a
    // trailing comma or period end the token ("acme, inc." stays words).
    const raw = match[0];
    const trimmed = raw.replace(/[,;!?]+$/, "");
    tokens.push({
      text: trimmed,
      lower: trimmed.toLowerCase(),
      start,
      end: start + trimmed.length,
      quoted: false,
    });
  }
  return tokens.filter((token) => token.text.length > 0);
}

/** Index terms of one word, exactly as the database tokenizer derives them. */
export function wordTerms(word: string): string[] {
  const parts = word
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const terms: string[] = [];
  for (const part of parts) {
    if (/\p{L}/u.test(part) && /\p{N}/u.test(part)) {
      for (const run of part.match(/\p{L}+|\p{N}+/gu) ?? []) terms.push(run.slice(0, 64));
    } else if (part.length >= 2 || /\p{N}/u.test(part)) {
      terms.push(part.slice(0, 64));
    }
  }
  return [...new Set(terms)];
}

const CURRENCY_PREFIX =
  /^(?:[a-z]{0,2}\$|€|£|¥|₹|₩|₪|₱|₦|₫|฿|r\$|chf|cad|usd|eur|gbp|aud|nzd|jpy|inr|mxn|zar|sek|nok|dkk)\s*/i;
const CURRENCY_SUFFIX =
  /\s*(?:€|£|¥|₹|kr|chf|cad|usd|eur|gbp|aud|nzd|jpy|inr|mxn|zar|sek|nok|dkk)$/i;

/** Whole cents of a non-negative decimal string with up to four decimals, rounded half up. */
function decimalToCents(whole: string, fraction: string): string {
  const digits = `${whole}${(fraction + "0000").slice(0, 4)}`.replace(/^0+(?=\d)/, "");
  const value = BigInt(digits);
  const cents = (value + 50n) / 100n;
  return cents.toString();
}

/**
 * An amount as typed: optional currency symbol or code, optional sign or
 * accounting parentheses, then digits with correctly grouped thousands and
 * up to four decimals. A grouped European form (1.234,56) reads with comma
 * decimals. A lone comma between digits (1,2) is not a number. `bare` is
 * true when nothing but digits was typed, so the token may equally be a
 * document number. `precision` is how many decimals were written.
 */
export function parseAmountToken(
  raw: string,
): { whole: string; fraction: string; bare: boolean; precision: number } | null {
  let text = raw.trim();
  let marked = false;
  if (/^\(.*\)$/.test(text)) {
    text = text.slice(1, -1).trim();
    marked = true;
  }
  if (/^[-+−]/.test(text)) {
    text = text.slice(1).trim();
    marked = true;
  }
  const prefixed = text.replace(CURRENCY_PREFIX, "");
  if (prefixed !== text) marked = true;
  text = prefixed;
  const suffixed = text.replace(CURRENCY_SUFFIX, "");
  if (suffixed !== text) marked = true;
  text = suffixed.trim();
  if (/^[-−]/.test(text)) {
    text = text.slice(1);
    marked = true;
  }
  let match = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,4}))?$/.exec(text);
  if (match) {
    const grouped = match[1]!.includes(",");
    const fraction = match[2] ?? "";
    if (!grouped && !fraction && /^0\d/.test(match[1]!)) return null;
    return {
      whole: match[1]!.replace(/,/g, ""),
      fraction,
      bare: !marked && !grouped && !fraction,
      precision: fraction.length,
    };
  }
  match = /^(\d{1,3}(?:\.\d{3})+),(\d{1,2})$/.exec(text);
  if (match) {
    return {
      whole: match[1]!.replace(/\./g, ""),
      fraction: match[2]!,
      bare: false,
      precision: match[2]!.length,
    };
  }
  return null;
}

/**
 * Cents an amount as typed covers. Written to the cent it is exact; with
 * fewer decimals it covers every amount it begins (1234 is 1,234.00 through
 * 1,234.99; 1234.5 is 1,234.50 through 1,234.59), so typing narrows the
 * results digit by digit.
 */
function amountRange(amount: { whole: string; fraction: string; precision: number }): CentsRange {
  const base = BigInt(decimalToCents(amount.whole, amount.fraction.slice(0, 2)));
  if (amount.precision >= 2) {
    if (amount.precision > 2) {
      const exact = decimalToCents(amount.whole, amount.fraction);
      return { min: exact, max: exact };
    }
    return { min: base.toString(), max: base.toString() };
  }
  const span = amount.precision === 1 ? 9n : 99n;
  return { min: base.toString(), max: (base + span).toString() };
}

function exactCents(amount: { whole: string; fraction: string }): bigint {
  return BigInt(decimalToCents(amount.whole, amount.fraction));
}

/** Longest vocabulary phrase starting at token `i`; returns the tokens it spans. */
function phraseAt(tokens: Token[], i: number, phrases: readonly string[]): number {
  let best = 0;
  for (const phrase of phrases) {
    const parts = phrase.split(" ");
    if (parts.length <= best || i + parts.length > tokens.length) continue;
    if (parts.every((part, k) => !tokens[i + k]!.quoted && tokens[i + k]!.lower === part))
      best = parts.length;
  }
  return best;
}

function monthIndex(word: string, vocabulary: SearchVocabulary): number | null {
  const lower = word.toLowerCase().replace(/\.$/, "");
  const index = vocabulary.months.findIndex((names) => names.includes(lower));
  return index >= 0 ? index + 1 : null;
}

function validDate(year: number, month: number, day: number): string | null {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return null;
  if (day > daysInCivilMonth(year, month)) return null;
  return civilDateFromParts(year, month, day);
}

function fullYear(text: string, today: string): number | null {
  if (/^\d{4}$/.test(text)) return Number(text);
  if (/^\d{2}$/.test(text)) {
    const century = Math.floor(Number(today.slice(0, 4)) / 100) * 100;
    return century + Number(text);
  }
  return null;
}

/** A calendar date written as one token: ISO, or numeric in the reader's order. */
function numericDate(text: string, options: ParseOptions): string | null {
  let match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text);
  if (match) return validDate(Number(match[1]), Number(match[2]), Number(match[3]));
  match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(text);
  if (!match) return null;
  const a = Number(match[1]);
  const b = Number(match[2]);
  const year = fullYear(match[3]!, options.today);
  if (year === null) return null;
  const monthFirst = options.dateOrder !== "dmy" ? a <= 12 || b > 12 : b > 12 && a <= 12;
  return monthFirst ? validDate(year, a, b) : validDate(year, b, a);
}

type Span = { from: string; to: string };

function fiscalYearSpan(endYear: number, startMonth: number): Span {
  // A fiscal year is named for the calendar year it ends in.
  const from =
    startMonth === 1
      ? civilDateFromParts(endYear, 1, 1)
      : civilDateFromParts(endYear - 1, startMonth, 1);
  return { from, to: addCalendarDays(addMonthsStart(from, 12), -1) };
}

function fiscalYearOf(iso: string, startMonth: number): number {
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  return startMonth === 1 || month < startMonth ? year : year + 1;
}

function quarterSpan(fiscalYear: number, quarter: number, startMonth: number): Span {
  const from = addMonthsStart(fiscalYearSpan(fiscalYear, startMonth).from, (quarter - 1) * 3);
  return { from, to: addCalendarDays(addMonthsStart(from, 3), -1) };
}

function quarterOf(iso: string, startMonth: number): { fiscalYear: number; quarter: number } {
  const fiscalYear = fiscalYearOf(iso, startMonth);
  const from = fiscalYearSpan(fiscalYear, startMonth).from;
  const months =
    (Number(iso.slice(0, 4)) - Number(from.slice(0, 4))) * 12 +
    (Number(iso.slice(5, 7)) - Number(from.slice(5, 7)));
  return { fiscalYear, quarter: Math.floor(months / 3) + 1 };
}

/**
 * A date or date span starting at token `i`: returns the span and how many
 * tokens it used, or null.
 */
function dateAt(
  tokens: Token[],
  i: number,
  options: ParseOptions,
): { span: Span; used: number } | null {
  const v = options.vocabulary;
  const today = options.today;
  const word = (k: number) =>
    tokens[i + k] && !tokens[i + k]!.quoted ? tokens[i + k]!.lower : null;
  const has = (k: number, list: string[]) => {
    const w = word(k);
    return w !== null && list.includes(w);
  };
  const single = (from: string, to: string = from, used = 1) => ({ span: { from, to }, used });

  if (has(0, v.today)) return single(today);
  if (has(0, v.yesterday)) return single(addCalendarDays(today, -1));
  if (has(0, v.tomorrow)) return single(addCalendarDays(today, 1));
  const toDate = phraseAt(tokens, i, v.yearToDate);
  if (toDate)
    return single(
      fiscalYearSpan(
        fiscalYearOf(today, options.fiscalYearStartMonth),
        options.fiscalYearStartMonth,
      ).from,
      today,
      toDate,
    );
  const monthToDate = phraseAt(tokens, i, v.monthToDate);
  if (monthToDate) return single(startOfMonth(today), today, monthToDate);
  const quarterToDate = phraseAt(tokens, i, v.quarterToDate);
  if (quarterToDate) {
    const { fiscalYear, quarter } = quarterOf(today, options.fiscalYearStartMonth);
    return single(
      quarterSpan(fiscalYear, quarter, options.fiscalYearStartMonth).from,
      today,
      quarterToDate,
    );
  }

  // this|last|next week|month|quarter|year
  for (const [list, offset] of [
    [v.thisPeriod, 0],
    [v.lastPeriod, -1],
    [v.nextPeriod, 1],
  ] as const) {
    if (!has(0, list)) continue;
    if (has(1, v.week)) {
      const monday = addCalendarDays(mondayOfIsoWeek(today), offset * 7);
      return single(monday, addCalendarDays(monday, 6), 2);
    }
    if (has(1, v.month)) {
      const from = addMonthsStart(startOfMonth(today), offset);
      return single(from, endOfMonth(from), 2);
    }
    if (has(1, v.quarter)) {
      const { fiscalYear, quarter } = quarterOf(today, options.fiscalYearStartMonth);
      const index = fiscalYear * 4 + (quarter - 1) + offset;
      return {
        span: quarterSpan(Math.floor(index / 4), (index % 4) + 1, options.fiscalYearStartMonth),
        used: 2,
      };
    }
    if (has(1, v.year)) {
      const fiscalYear = fiscalYearOf(today, options.fiscalYearStartMonth) + offset;
      return { span: fiscalYearSpan(fiscalYear, options.fiscalYearStartMonth), used: 2 };
    }
  }
  // past|last N days|weeks|months|years
  if (has(0, v.pastPeriod) && word(1) && /^\d{1,4}$/.test(word(1)!)) {
    const n = Number(word(1));
    if (n >= 1) {
      if (has(2, v.day)) return single(addCalendarDays(today, -(n - 1)), today, 3);
      if (has(2, v.week)) return single(addCalendarDays(today, -(n * 7 - 1)), today, 3);
      if (has(2, v.month)) return single(addMonthsClampedDay(today, -n), today, 3);
      if (has(2, v.year)) return single(addMonthsClampedDay(today, -12 * n), today, 3);
    }
  }
  // Q3, Q3 2026, FY26, FY2026
  const quarterMatch = word(0) ? /^q([1-4])$/.exec(word(0)!) : null;
  if (quarterMatch) {
    const yearText = word(1);
    const year = yearText ? fullYear(yearText.replace(/^fy/, ""), today) : null;
    const fiscalYear = year ?? fiscalYearOf(today, options.fiscalYearStartMonth);
    return {
      span: quarterSpan(fiscalYear, Number(quarterMatch[1]), options.fiscalYearStartMonth),
      used: year !== null && yearText && /^(fy)?\d{2,4}$/.test(yearText) ? 2 : 1,
    };
  }
  const fiscalMatch = word(0) ? /^fy(\d{2}|\d{4})$/.exec(word(0)!) : null;
  if (fiscalMatch) {
    const year = fullYear(fiscalMatch[1]!, today);
    if (year !== null) return { span: fiscalYearSpan(year, options.fiscalYearStartMonth), used: 1 };
  }
  // A one-token date.
  const numeric = word(0) ? numericDate(word(0)!, options) : null;
  if (numeric) return single(numeric);
  // Month-name forms: "apr 15 2026", "april 15, 2026", "15 april 2026", "april 2026".
  const month0 = word(0) ? monthIndex(word(0)!, v) : null;
  if (month0) {
    const dayText = word(1)?.replace(/(st|nd|rd|th),?$|,$/, "");
    if (dayText && /^\d{1,2}$/.test(dayText)) {
      const yearText = word(2)?.replace(/,$/, "");
      const year = yearText ? fullYear(yearText, today) : null;
      if (year !== null && yearText && /^\d{4}$/.test(yearText)) {
        const date = validDate(year, month0, Number(dayText));
        if (date) return single(date, date, 3);
      }
      const date = validDate(Number(today.slice(0, 4)), month0, Number(dayText));
      if (date) return single(date, date, 2);
    }
    const yearText = word(1);
    if (yearText && /^\d{4}$/.test(yearText)) {
      const from = civilDateFromParts(Number(yearText), month0, 1);
      return single(from, endOfMonth(from), 2);
    }
    return null;
  }
  const dayFirst = word(0)?.replace(/(st|nd|rd|th)$/, "");
  if (dayFirst && /^\d{1,2}$/.test(dayFirst) && word(1)) {
    const month = monthIndex(word(1)!, v);
    if (month) {
      const yearText = word(2);
      if (yearText && /^\d{4}$/.test(yearText)) {
        const date = validDate(Number(yearText), month, Number(dayFirst));
        if (date) return single(date, date, 3);
      }
      const date = validDate(Number(today.slice(0, 4)), month, Number(dayFirst));
      if (date) return single(date, date, 2);
    }
  }
  return null;
}

function addMonthsClampedDay(iso: string, months: number): string {
  const first = addMonthsStart(iso, months);
  const day = Math.min(
    Number(iso.slice(8, 10)),
    daysInCivilMonth(Number(first.slice(0, 4)), Number(first.slice(5, 7))),
  );
  return civilDateFromParts(Number(first.slice(0, 4)), Number(first.slice(5, 7)), day);
}

/** A bare word for a whole month or year after "in"/"during": "in april", "in 2025". */
function periodAfterDuring(
  tokens: Token[],
  i: number,
  options: ParseOptions,
): { span: Span; used: number } | null {
  const word = tokens[i] && !tokens[i]!.quoted ? tokens[i]!.lower : null;
  if (!word) return null;
  if (/^\d{4}$/.test(word)) {
    const year = Number(word);
    if (year >= 1900 && year <= 2200)
      return {
        span: { from: civilDateFromParts(year, 1, 1), to: civilDateFromParts(year, 12, 31) },
        used: 1,
      };
  }
  const month = monthIndex(word, options.vocabulary);
  if (month) {
    // The most recent such month, this year or last.
    const thisYear = Number(options.today.slice(0, 4));
    const year = month > Number(options.today.slice(5, 7)) ? thisYear - 1 : thisYear;
    const from = civilDateFromParts(year, month, 1);
    return { span: { from, to: endOfMonth(from) }, used: 1 };
  }
  return dateAt(tokens, i, options);
}

/** Read a query into constraints and chips. */
export function parseSearchQuery(raw: string, options: ParseOptions): ParsedSearch {
  const q = raw.trim().slice(0, 200);
  const tokens = tokenize(q);
  const v = options.vocabulary;
  const words: SearchWord[] = [];
  const chips: SearchChip[] = [];
  const scopes: SearchScope[] = [];
  let amount: ParsedSearch["amount"] = null;
  let dates: ParsedSearch["dates"] = null;
  let status: SearchStatus | null = null;
  const scopePhrases = SEARCH_SCOPES.flatMap((scope) =>
    (v.scopes[scope] ?? []).map((phrase) => ({ scope, phrase })),
  );

  const setDates = (from: string | null, to: string | null, start: number, end: number) => {
    if (dates) return false;
    dates = { from, to };
    chips.push({ kind: "date", from, to, start, end });
    return true;
  };
  const setAmount = (range: CentsRange, approximate: boolean, start: number, end: number) => {
    if (amount) return false;
    amount = { ...range, approximate };
    chips.push({ kind: "amount", min: range.min, max: range.max, approximate, start, end });
    return true;
  };
  const amountOf = (k: number) => {
    const token = tokens[k];
    return token && !token.quoted ? parseAmountToken(token.text) : null;
  };

  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (token.quoted) {
      for (const term of wordTerms(token.text))
        words.push({ text: term, terms: [term], exact: true, amount: null });
      i += 1;
      continue;
    }

    // scope:rest — a record-type prefix scoping the rest of the token.
    const prefix = /^([\p{L}]{2,}):(.*)$/u.exec(token.text);
    if (prefix) {
      const name = prefix[1]!.toLowerCase();
      const hits = scopePhrases.filter(
        (entry) => !entry.phrase.includes(" ") && entry.phrase.startsWith(name),
      );
      const scopesHit = [...new Set(hits.map((hit) => hit.scope))];
      const exact = hits.filter((hit) => hit.phrase === name).map((hit) => hit.scope);
      const chosen = exact.length ? [...new Set(exact)] : scopesHit.length === 1 ? scopesHit : [];
      if (chosen.length) {
        for (const scope of chosen) if (!scopes.includes(scope)) scopes.push(scope);
        chips.push({
          kind: "scope",
          scope: chosen[0]!,
          start: token.start,
          end: token.start + prefix[1]!.length + 1,
        });
        const rest = prefix[2]!;
        if (rest) {
          tokens[i] = {
            ...token,
            text: rest,
            lower: rest.toLowerCase(),
            start: token.start + prefix[1]!.length + 1,
          };
          continue;
        }
        i += 1;
        continue;
      }
    }

    // between A and B
    const betweenLen = phraseAt(tokens, i, v.between);
    if (betweenLen) {
      const a = amountOf(i + betweenLen);
      const andLen = a ? phraseAt(tokens, i + betweenLen + 1, v.and) : 0;
      const b = andLen ? amountOf(i + betweenLen + 1 + andLen) : null;
      if (a && b) {
        const lo = exactCents(a);
        const hi = exactCents(b);
        const end = tokens[i + betweenLen + 1 + andLen]!.end;
        setAmount(
          { min: (lo < hi ? lo : hi).toString(), max: (lo < hi ? hi : lo).toString() },
          false,
          token.start,
          end,
        );
        i += betweenLen + 2 + andLen;
        continue;
      }
      const da = dateAt(tokens, i + betweenLen, options);
      if (da) {
        const at = i + betweenLen + da.used;
        const andDate = phraseAt(tokens, at, v.and);
        const db = andDate ? dateAt(tokens, at + andDate, options) : null;
        if (db) {
          const last = tokens[at + andDate + db.used - 1]!;
          setDates(da.span.from, db.span.to, token.start, last.end);
          i = at + andDate + db.used;
          continue;
        }
      }
    }

    // Operators: >5000, > 5000, over 5000, at least 5000, ~1234, about 1234
    const operatorAttached = /^(>=|<=|>|<|~)(.+)$/.exec(token.text);
    const operators: [string[], "gt" | "ge" | "lt" | "le" | "approx"][] = [
      [v.greaterOrEqual, "ge"],
      [v.lessOrEqual, "le"],
      [v.greater, "gt"],
      [v.less, "lt"],
      [v.approximately, "approx"],
    ];
    let operator: "gt" | "ge" | "lt" | "le" | "approx" | null = null;
    let operandIndex = i;
    let operandAttached: ReturnType<typeof parseAmountToken> = null;
    if (operatorAttached) operandAttached = parseAmountToken(operatorAttached[2]!);
    if (operatorAttached && operandAttached) {
      const symbol = operatorAttached[1]!;
      operator =
        symbol === ">="
          ? "ge"
          : symbol === "<="
            ? "le"
            : symbol === ">"
              ? "gt"
              : symbol === "<"
                ? "lt"
                : "approx";
    } else {
      operandAttached = null;
      for (const [list, op] of operators) {
        const len = phraseAt(tokens, i, list);
        if (len && amountOf(i + len)) {
          operator = op;
          operandIndex = i + len;
          break;
        }
      }
    }
    if (operator) {
      const operand = operandAttached ?? amountOf(operandIndex)!;
      const cents = exactCents(operand);
      const end = operandAttached ? token.end : tokens[operandIndex]!.end;
      const range: CentsRange =
        operator === "gt"
          ? { min: (cents + 1n).toString(), max: null }
          : operator === "ge"
            ? { min: cents.toString(), max: null }
            : operator === "lt"
              ? { min: "0", max: (cents > 0n ? cents - 1n : 0n).toString() }
              : operator === "le"
                ? { min: "0", max: cents.toString() }
                : {
                    min: (cents - (cents / 100n > 0n ? cents / 100n : 1n)).toString(),
                    max: (cents + (cents / 100n > 0n ? cents / 100n : 1n)).toString(),
                  };
      if (setAmount(range, operator === "approx", token.start, end)) {
        i = operandAttached ? i + 1 : operandIndex + 1;
        continue;
      }
    }

    // A..B or A-B amount ranges written as one token.
    const rangeMatch = /^(.+?)(?:\.\.|–|—)(.+)$/.exec(token.text);
    if (rangeMatch) {
      const a = parseAmountToken(rangeMatch[1]!);
      const b = parseAmountToken(rangeMatch[2]!);
      if (a && b) {
        const lo = exactCents(a);
        const hi = exactCents(b);
        if (
          setAmount(
            { min: (lo < hi ? lo : hi).toString(), max: (lo < hi ? hi : lo).toString() },
            false,
            token.start,
            token.end,
          )
        ) {
          i += 1;
          continue;
        }
      }
    }

    // since/after/from DATE, before/until DATE, in/during PERIOD
    for (const [list, side] of [
      [v.since, "from"],
      [v.before, "to"],
      [v.during, "in"],
    ] as const) {
      const len = phraseAt(tokens, i, list);
      if (!len) continue;
      const found =
        side === "in"
          ? periodAfterDuring(tokens, i + len, options)
          : dateAt(tokens, i + len, options);
      if (!found) continue;
      const last = tokens[i + len + found.used - 1]!;
      const ok =
        side === "from"
          ? setDates(found.span.from, null, token.start, last.end)
          : side === "to"
            ? setDates(null, addCalendarDays(found.span.from, -1), token.start, last.end)
            : setDates(found.span.from, found.span.to, token.start, last.end);
      if (ok) {
        i += len + found.used;
        operator = null;
        break;
      }
    }
    if (i >= tokens.length || tokens[i] !== token) continue;

    // A date or date span, optionally "DATE to DATE".
    const date = dateAt(tokens, i, options);
    if (date && !dates) {
      const at = i + date.used;
      const throughLen = phraseAt(tokens, at, v.through);
      const second = throughLen ? dateAt(tokens, at + throughLen, options) : null;
      if (second) {
        const last = tokens[at + throughLen + second.used - 1]!;
        setDates(date.span.from, second.span.to, token.start, last.end);
        i = at + throughLen + second.used;
      } else {
        setDates(date.span.from, date.span.to, token.start, tokens[at - 1]!.end);
        i = at;
      }
      continue;
    }

    // Statuses and scopes (longest phrase wins).
    let statusLen = 0;
    let statusHit: SearchStatus | null = null;
    for (const candidate of SEARCH_STATUSES) {
      const len = phraseAt(tokens, i, v.statuses[candidate] ?? []);
      if (len > statusLen) {
        statusLen = len;
        statusHit = candidate;
      }
    }
    let scopeLen = 0;
    let scopeHit: SearchScope | null = null;
    for (const { scope, phrase } of scopePhrases) {
      const len = phraseAt(tokens, i, [phrase]);
      if (len > scopeLen) {
        scopeLen = len;
        scopeHit = scope;
      }
    }
    if (statusHit && statusLen >= scopeLen && !status) {
      status = statusHit;
      chips.push({
        kind: "status",
        status: statusHit,
        start: token.start,
        end: tokens[i + statusLen - 1]!.end,
      });
      i += statusLen;
      continue;
    }
    if (scopeHit) {
      if (!scopes.includes(scopeHit)) scopes.push(scopeHit);
      chips.push({
        kind: "scope",
        scope: scopeHit,
        start: token.start,
        end: tokens[i + scopeLen - 1]!.end,
      });
      i += scopeLen;
      continue;
    }

    // An amount on its own. A bare number is also a word (a document number
    // or a reference); anything written like money is only an amount.
    // A currency written apart from its amount ("CAD 1,250") joins it.
    const currencyAlone =
      /^(?:[a-z]{0,2}\$|€|£|¥|₹|chf|cad|usd|eur|gbp|aud|nzd|jpy|inr|mxn|zar|sek|nok|dkk)$/i;
    if (currencyAlone.test(token.text) && amountOf(i + 1)) {
      const next = amountOf(i + 1)!;
      if (setAmount(amountRange(next), false, token.start, tokens[i + 1]!.end)) {
        i += 2;
        continue;
      }
    }
    const money = amountOf(i);
    if (money && !money.bare) {
      if (setAmount(amountRange(money), false, token.start, token.end)) {
        i += 1;
        continue;
      }
    }

    if (v.stopwords.includes(token.lower) && tokens.length > 1) {
      i += 1;
      continue;
    }
    const terms = wordTerms(token.text);
    if (terms.length) {
      words.push({
        text: token.lower,
        terms,
        exact: false,
        amount: money && money.bare && money.whole.length <= 16 ? amountRange(money) : null,
      });
    }
    i += 1;
  }

  return { q, words, amount, dates, status, scopes, chips };
}

/** The text a chip came from removed, keeping the rest of the query as typed. */
export function withoutChip(q: string, chip: { start: number; end: number }): string {
  return `${q.slice(0, chip.start)} ${q.slice(chip.end)}`.replace(/\s+/g, " ").trim();
}

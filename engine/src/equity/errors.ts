import {
  renderRefusal,
  type CatalogRefusal,
  type RefusalValue,
  type RefusalValues,
} from "../platform/catalog-refusal.ts";
import {
  EQUITY_REFUSALS,
  type EquityRefusalKey,
  type EquityRefusalValues,
} from "./refusals/index.ts";
import { EQUITY_TERMS, type EquityTermName } from "./refusals/terms.ts";

export { formatRefusalDate, type RefusalValue } from "../platform/catalog-refusal.ts";
export type { EquityRefusalKey, EquityRefusalValues } from "./refusals/index.ts";
export type { EquityTermName } from "./refusals/terms.ts";

/** The named refusal every equity command, read and model raises. */
export type EquityErrorStatus = 403 | 404 | 409 | 422;

/**
 * A catalog-backed equity refusal. Its key names the entry under
 * `refusals.equity` in the locale catalogs, which the application renders in
 * the reader's language with the refusal's typed figures; `message` and
 * `remedy` are the English rendering, for logs and callers without a reader.
 */
export class EquityError extends Error implements CatalogRefusal {
  readonly name = "EquityError";
  readonly status: EquityErrorStatus;
  readonly code: string;
  readonly remedy: string;
  readonly field?: string;
  readonly key: EquityRefusalKey;
  readonly catalogKey: string;
  /** The figures the message and remedy name. */
  readonly values: RefusalValues;

  constructor(
    key: EquityRefusalKey,
    options: {
      values?: RefusalValues;
      status?: EquityErrorStatus;
      field?: string;
      cause?: unknown;
    } = {},
  ) {
    const spec = EQUITY_REFUSALS[key];
    const values = options.values ?? {};
    super(renderRefusal(spec.message, values), { cause: options.cause });
    this.key = key;
    this.catalogKey = `equity.${key}`;
    this.code = spec.code;
    this.status = options.status ?? ("status" in spec ? (spec.status as EquityErrorStatus) : 422);
    this.remedy = renderRefusal(spec.remedy, values);
    this.values = values;
    if (options.field !== undefined) this.field = options.field;
  }
}

type RefusalOptions = { status?: EquityErrorStatus; field?: string; cause?: unknown };

/**
 * An equity refusal from its catalog key and the figures its templates
 * name, typed per key: a share count where the entry takes shares, a date
 * where it takes a date.
 */
export function equityError<K extends EquityRefusalKey>(
  key: K,
  ...args: keyof EquityRefusalValues<K> extends never
    ? [values?: Record<string, never>, options?: RefusalOptions]
    : [values: EquityRefusalValues<K>, options?: RefusalOptions]
): EquityError {
  const [values, options] = args;
  return new EquityError(key, { ...options, values: values as RefusalValues | undefined });
}

type Figure<K extends RefusalValue["kind"]> = Extract<RefusalValue, { kind: K }>;

/** Figures for refusal templates. */
export const fig = {
  shares: (value: bigint | string): Figure<"shares"> => ({ kind: "shares", value }),
  count: (value: bigint | number): Figure<"count"> => ({ kind: "count", value }),
  money: (value: string, currency: string): Figure<"money"> => ({ kind: "money", value, currency }),
  price: (value: string, currency: string | null = null): Figure<"price"> => ({
    kind: "price",
    value,
    currency,
  }),
  decimal: (value: string): Figure<"decimal"> => ({ kind: "decimal", value }),
  multiple: (value: string): Figure<"multiple"> => ({ kind: "multiple", value }),
  percent: (value: string): Figure<"percent"> => ({ kind: "percent", value }),
  date: (value: string): Figure<"date"> => ({ kind: "date", value }),
  period: (
    label: string,
    startsOn: string | null = null,
    endsOn: string | null = null,
  ): Figure<"period"> => ({ kind: "period", label, startsOn, endsOn }),
  text: (value: string): Figure<"text"> => ({ kind: "text", value }),
  list: (value: readonly string[]): Figure<"list"> => ({ kind: "list", value }),
  choice: (value: string): Figure<"choice"> => ({ kind: "choice", value }),
  term: (name: EquityTermName): Figure<"term"> => ({ kind: "term", ...EQUITY_TERMS[name] }),
} as const;

export const EQUITY_FEATURE_KEY = "equity";

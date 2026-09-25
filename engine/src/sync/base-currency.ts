import { SUPPORTED_CURRENCIES } from "../fx/currencies.ts";

const ISO_4217_CODES: ReadonlySet<string> = new Set(SUPPORTED_CURRENCIES.map((currency) => currency.code));

/** Returns missing or invalid rather than allowing a connector to guess the source book currency. */
export function refusedConnectionBaseCurrency(value: unknown): "missing" | "invalid" | null {
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!code) return "missing";
  return ISO_4217_CODES.has(code) ? null : "invalid";
}

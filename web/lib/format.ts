// Default currency symbol for on-screen amounts. Reports pass an explicit
// per-org symbol (currencySymbol(org.base_currency)); list/tile callers rely on
// this default so every money value renders with a symbol — it IS a financial
// app. "$" covers CAD/USD; multi-currency surfaces pass the resolved symbol.
export function money(v: string | number | null | undefined, symbol = "$"): string {
  if (v === null || v === undefined) return "";
  const n = Number(v);
  if (Number.isNaN(n)) return String(v);
  const abs = n.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? abs.replace("-", `-${symbol}`) : `${symbol}${abs}`;
}

export function dateTime(v: string | Date | null | undefined): string {
  if (!v) return "";
  return new Date(v).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" });
}

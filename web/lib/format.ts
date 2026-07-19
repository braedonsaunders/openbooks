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

/** Compact money for tiles/bars: $1.2M / $34K / $920. */
export function moneyCompact(n: number, symbol = "$"): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}${symbol}${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}${symbol}${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}${symbol}${(abs / 1e3).toFixed(1)}K`;
  return `${sign}${symbol}${abs.toFixed(0)}`;
}

export function dateTime(v: string | Date | null | undefined): string {
  if (!v) return "";
  return new Date(v).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" });
}

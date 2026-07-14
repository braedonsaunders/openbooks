export function money(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  const n = Number(v);
  if (Number.isNaN(n)) return String(v);
  return n.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function dateTime(v: string | Date | null | undefined): string {
  if (!v) return "";
  return new Date(v).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" });
}

export function dateTime(v: string | Date | null | undefined): string {
  if (!v) return "";
  return new Date(v).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" });
}

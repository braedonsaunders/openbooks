/**
 * Empty-state cause for the 1099-NEC preparation worksheet. When no vendor
 * rows render, the generic "nothing traced" copy stays only for a truly
 * quiet year; anything the filing can name — paid vendors missing
 * reportability details, or vendor payments waiting to be posted — comes
 * back as a discriminated cause so the loader can name it with a link.
 * Pure: no database, no translations, no components.
 */
export type NecEmptyCause =
  | { kind: "vendors"; vendors: { partyId: string; name: string; total: string }[] }
  | { kind: "unposted"; count: number; total: string }
  | null;

const VENDOR_CAUSES = new Set([
  "unflagged_over_threshold",
  "missing_tin",
  "missing_form_assignment",
]);

export function necEmptyCause(args: {
  exceptions: { kind: string; partyId: string | null; partyName: string; amount?: string }[];
  unposted: { count: number; total: string } | null;
}): NecEmptyCause {
  const vendors: { partyId: string; name: string; total: string }[] = [];
  for (const exception of args.exceptions) {
    if (!exception.partyId || !VENDOR_CAUSES.has(exception.kind)) continue;
    if (vendors.length >= 3) break;
    vendors.push({
      partyId: exception.partyId,
      name: exception.partyName,
      total: exception.amount ?? "0",
    });
  }
  if (vendors.length > 0) return { kind: "vendors", vendors };
  if (args.unposted && args.unposted.count > 0) return { kind: "unposted", ...args.unposted };
  return null;
}

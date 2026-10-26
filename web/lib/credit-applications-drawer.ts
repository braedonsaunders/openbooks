/**
 * The drawer prop that mounts the credit-application panel.
 *
 * A posted customer credit memo settles against its customer's open invoices,
 * and a posted vendor credit against its vendor's open bills. Every drawer that
 * can open one of those credits (the AR and AP lists, and the party, report and
 * global drawers) builds this prop here, so the panel appears on each of them
 * under the same rule. The engine and the panel's own reads still decide what
 * may be settled; this only says which document carries the control.
 */
export interface CreditApplicationsDrawer {
  documentId: string;
  side: "ap" | "ar";
  partyId: string | null;
  canApply: boolean;
}

export function creditApplicationsDrawer(
  doc: Record<string, unknown> | null | undefined,
  canPay: { ar: boolean; ap: boolean },
): CreditApplicationsDrawer | null {
  if (!doc || doc.status !== "posted" || typeof doc.id !== "string") return null;
  const side = doc.kind === "customer_credit" ? "ar" : doc.kind === "vendor_credit" ? "ap" : null;
  if (!side) return null;
  return {
    documentId: doc.id,
    side,
    partyId: typeof doc.party_id === "string" ? doc.party_id : null,
    canApply: canPay[side],
  };
}

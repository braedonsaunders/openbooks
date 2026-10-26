import { decimalCmp } from "./statement-format";

/**
 * The drawer prop that mounts the invoice write-off panel. Only a posted
 * customer invoice that still owes money carries it, and only for a viewer who
 * may both post and settle. The engine re-checks the balance, the account
 * configuration and the periods on submit; this prop only says where the
 * control belongs.
 */
export interface InvoiceWriteOffDrawer {
  documentId: string;
  currency: string;
  /** The invoice's open balance from the shared balance-due reader. */
  openBalance: string;
}

export function invoiceWriteOffDrawer(
  doc: Record<string, unknown> | null | undefined,
  canWriteOff: boolean,
): InvoiceWriteOffDrawer | null {
  if (!canWriteOff || !doc) return null;
  if (doc.kind !== "customer_invoice" || doc.status !== "posted" || typeof doc.id !== "string")
    return null;
  const balance = typeof doc.balance_due === "string" ? doc.balance_due : null;
  if (balance === null || decimalCmp(balance, "0") <= 0) return null;
  return { documentId: doc.id, currency: String(doc.currency ?? ""), openBalance: balance };
}

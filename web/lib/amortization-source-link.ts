import { journalEntryDrawerHref, listRecordDrawerHref } from "./cross-module-drawer-links";

export function amortizationSourceHref(
  kind: string | null,
  documentId: string | null,
): string | null {
  if (!kind || !documentId) return null;
  if (kind === "vendor_bill") return listRecordDrawerHref("vendor_bill", documentId);
  if (kind === "journal") return journalEntryDrawerHref(documentId);
  if (kind === "expense_report") return listRecordDrawerHref("expense_report", documentId);
  return null;
}

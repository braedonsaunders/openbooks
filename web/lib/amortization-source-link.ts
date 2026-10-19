export function amortizationSourceHref(kind: string | null, documentId: string | null): string | null {
  if (!kind || !documentId) return null
  if (kind === 'vendor_bill') return `/ap/bills?doc=${documentId}`
  if (kind === 'journal') return `/journal?entry=${documentId}`
  if (kind === 'expense_report') return `/expenses?doc=${documentId}`
  return null
}

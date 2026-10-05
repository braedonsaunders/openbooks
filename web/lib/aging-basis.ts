/**
 * The one aging rule shared by the AR/AP aging report and the cash cockpits.
 *
 * An open item ages from its due date. An item with no due date (no payment
 * terms) ages from its posting date, falling back to its document date —
 * the accounting-standard treatment, under which an untermed invoice is due
 * on issue. Treating it as permanently "current" would let a years-old
 * untermed invoice hide in the current column of one screen while the aging
 * report shows it 90+ days past due.
 *
 * The aging report applies the same precedence in SQL
 * (`coalesce(due_date, posting_date, document_date)`); both surfaces bucket
 * through {@link agingBucketIndex}.
 */
export function agingBasisDate<D>(item: { dueDate: D | null | undefined; postingDate: D | null | undefined; documentDate?: D | null }): D | null {
  return item.dueDate ?? item.postingDate ?? item.documentDate ?? null
}

/** Bucket index for days past the aging basis date: 0 current, 1 = 1–30, 2 = 31–60, 3 = 61–89, 4 = 90+. */
export function agingBucketIndex(daysPastDue: number): 0 | 1 | 2 | 3 | 4 {
  if (daysPastDue <= 0) return 0
  if (daysPastDue <= 30) return 1
  if (daysPastDue <= 60) return 2
  if (daysPastDue < 90) return 3
  return 4
}

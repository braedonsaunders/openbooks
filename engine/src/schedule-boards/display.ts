/** Ordered, tenant-defined visual rules; they do not change booking identity or hours. */
export interface CellColorRule {
  readonly field: 'bookingLabel' | 'targetName' | 'detail';
  readonly match: 'equals' | 'startsWith' | 'contains';
  readonly value: string;
  readonly color: string;
}
export function bookingColor(rules: readonly CellColorRule[], booking: { code: string | null; label: string | null; detail: string | null }): string | null {
  for (const rule of rules) {
    const raw = rule.field === 'bookingLabel' ? [booking.code ?? booking.label ?? '', booking.detail].filter(Boolean).join('/')
      : rule.field === 'targetName' ? booking.label ?? '' : booking.detail ?? '';
    const value = raw.trim().toUpperCase();
    const expected = rule.value.trim().toUpperCase();
    if (rule.match === 'equals' ? value === expected : rule.match === 'startsWith' ? value.startsWith(expected) : value.includes(expected)) return rule.color;
  }
  return null;
}

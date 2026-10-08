/** Ordered, tenant-defined visual rules; they do not change booking identity or hours. */
export interface CellColorRule {
  readonly field: 'bookingLabel' | 'targetName' | 'detail';
  readonly match: 'equals' | 'startsWith' | 'contains';
  readonly value: string;
  readonly color: string;
}
export function bookingColor(
  rules: readonly CellColorRule[],
  booking: { code: string | null; label: string | null; detail: string | null },
): string | null {
  for (const rule of rules) {
    const raw =
      rule.field === 'bookingLabel'
        ? [booking.code ?? booking.label ?? '', booking.detail]
            .filter(Boolean)
            .join('/')
        : rule.field === 'targetName'
          ? (booking.label ?? '')
          : (booking.detail ?? '');
    const value = raw.trim().toUpperCase();
    const expected = rule.value.trim().toUpperCase();
    if (
      rule.match === 'equals'
        ? value === expected
        : rule.match === 'startsWith'
          ? value.startsWith(expected)
          : value.includes(expected)
    )
      return rule.color;
  }
  return null;
}

/** Literal observations may use configured code colors without changing source identity. */
export function sourceObservationColor(
  rules: readonly CellColorRule[],
  label: string | null,
  codes: readonly { code: string; label: string; color: string | null }[],
): string | null {
  const literal = label ?? '';
  const code = codes
    .filter(
      (c) =>
        literal === c.code ||
        (literal.startsWith(c.code) &&
          /^\s*\//.test(literal.slice(c.code.length))),
    )
    .sort(
      (a, b) => b.code.length - a.code.length || a.code.localeCompare(b.code),
    )[0];
  const detail =
    code && literal !== code.code
      ? literal.slice(code.code.length).replace(/^\s*\//, '')
      : null;
  for (const rule of rules) {
    const color = bookingColor([rule], {
      code: literal,
      label: code?.label ?? label,
      detail: rule.field === 'detail' ? detail : null,
    });
    if (color) return color;
  }
  return code?.color ?? null;
}

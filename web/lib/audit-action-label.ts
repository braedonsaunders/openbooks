/**
 * Audit actions read with a label: the generic row operations (`insert`,
 * `post`, ...) and the named actions modules record (`equity.event.forfeit`,
 * `equity.round.amend`, ...). Each label lives under `admin.audit.actions`
 * keyed by the stored action code with its dots as underscores, because
 * message keys nest on dots. An action with no label keeps the caller's
 * rendering of its code.
 */
export function auditActionLabelKey(action: string): string {
  return `actions.${action.replaceAll(".", "_")}`;
}

/** The label of an audit action through an `admin.audit` translator, or the fallback for an action without one. */
export function auditActionLabel(
  t: { (key: never): string; has(key: never): boolean },
  action: string,
  fallback: (action: string) => string,
): string {
  const key = auditActionLabelKey(action) as never;
  return t.has(key) ? t(key) : fallback(action);
}

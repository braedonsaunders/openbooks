/**
 * Lifecycle statuses are stored snake_case (`pending_approval`) and labelled
 * under `common.status` in camelCase (`pendingApproval`). Always translate
 * through this mapping: the catalog also carries a raw `pending_approval`
 * key with a different meaning ("Submitted"), so looking a stored value up
 * verbatim shows the wrong word.
 */
export function statusMessageKey(status: string): string {
  return status.replace(/_([a-z0-9])/g, (_, next: string) => next.toUpperCase())
}

/**
 * A stored status in the reader's language, or the status in plain words
 * when the catalog does not name it (a module-specific status).
 */
export function statusLabel(
  status: string,
  translate: (key: string) => string,
  has: (key: string) => boolean,
): string {
  const key = `status.${statusMessageKey(status)}`
  return has(key) ? translate(key) : status.replace(/_/g, ' ')
}

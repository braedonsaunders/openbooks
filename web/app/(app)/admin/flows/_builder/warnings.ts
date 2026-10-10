/**
 * Name the node in every lint warning. The linter identifies nodes by
 * storage id (`trigger_9f2c…`), which means nothing to the author staring
 * at the canvas — each warning must carry the node's display name (kind +
 * label, e.g. "Trigger: A record is submitted") beside the problem it
 * reports. The storage id stays in parentheses for support and repair.
 *
 * Pure string work over the builder's own node names: lint strings are
 * untouched, so server-side enable-time errors enrich exactly like
 * author-time warnings when rendered through this helper.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function nameFlowWarnings(
  warnings: string[],
  names: ReadonlyMap<string, string>,
): string[] {
  if (names.size === 0) return warnings
  // Longest ids first: a short id that prefixes a longer one must not
  // claim the longer one's occurrences.
  const ids = [...names.keys()].sort((a, b) => b.length - a.length)
  return warnings.map((warning) => {
    let named = warning
    for (const id of ids) {
      const name = names.get(id)
      if (!name) continue
      const replacement = `${name} (${id})`
      named = named.replace(
        new RegExp(
          `(?:Trigger|Condition|Action|Gate|Node|node|Edge)\\s+("?)${escapeRegExp(id)}\\1|(?<![\\w-])${escapeRegExp(id)}(?![\\w-])`,
          'g',
        ),
        replacement,
      )
    }
    return named
  })
}

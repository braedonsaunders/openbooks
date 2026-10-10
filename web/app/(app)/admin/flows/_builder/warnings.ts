/**
 * Name the node in every lint warning. The linter identifies nodes by
 * storage id (`trigger_9f2c…`), which means nothing to the author staring
 * at the canvas — each warning must carry the node's display name (kind +
 * label, e.g. "Trigger: A record is submitted") instead of the id. Storage
 * ids are never shown: they are internal, they survive in old save errors
 * after the node is deleted, and naming them would point at a card that no
 * longer exists.
 *
 * Pure string work over the builder's own node names: lint strings are
 * untouched, so server-side enable-time errors enrich exactly like
 * author-time warnings when rendered through this helper.
 */

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const KIND_WORDS = ['Trigger', 'Condition', 'Action', 'Gate', 'Node', 'Edge'] as const

/**
 * Wording for a reference to a node that is no longer on the canvas (a
 * save error that outlived its node, or a server message about a deleted
 * step): the kind is kept so the problem still reads, the id is dropped.
 */
function removedStep(kindWord: string): string {
  const lower = kindWord.toLowerCase()
  if (lower === 'node' || lower === 'edge') return `a removed ${lower}`
  return `${kindWord} (removed step)`
}

/**
 * "Trigger <id>" / 'node "<id>"' → display name, or removed-step wording.
 * The lowercase engine form only counts when quoted (`node "x"`): an
 * unquoted `node` is usually prose ("add a trigger node to start it").
 */
function nameKindReferences(
  warning: string,
  names: ReadonlyMap<string, string>,
): string {
  return warning.replace(
    new RegExp(`((?:${KIND_WORDS.join('|')})\\s+("[\\w-]+"|[\\w-]+))|node\\s+("[\\w-]+")`, 'g'),
    (match) => {
      const word = match.trim().split(/\s+/)[0] ?? 'Node'
      const idMatch = /"([\w-]+)"|([\w-]+)\s*$/.exec(match)
      const id = idMatch?.[1] ?? idMatch?.[2] ?? ''
      return names.get(id) ?? removedStep(word)
    },
  )
}

export function nameFlowWarnings(
  warnings: string[],
  names: ReadonlyMap<string, string>,
): string[] {
  // Longest ids first: a short id that prefixes a longer one must not
  // claim the longer one's occurrences.
  const ids = [...names.keys()].sort((a, b) => b.length - a.length)
  return warnings.map((warning) => {
    let named = nameKindReferences(warning, names)
    // Bare or quoted mentions of live nodes ("see <id> on the canvas").
    for (const id of ids) {
      const name = names.get(id)
      if (!name) continue
      named = named.replace(
        new RegExp(`"${escapeRegExp(id)}"|(?<![\\w-])${escapeRegExp(id)}(?![\\w-])`, 'g'),
        name,
      )
    }
    return named
  })
}

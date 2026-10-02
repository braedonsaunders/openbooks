/** Reminder identity is part of the delivery deduplication key. Editing a
 * policy must preserve existing identities, including legacy sequence-based
 * edits, rather than making previously issued reminders eligible again. */
export function dunningStageIdentities(
  previous: { id: string; sequence: number }[],
  incoming: { id?: string; sequence: number }[],
): { ok: true; ids: (string | null)[] } | { ok: false; error: string } {
  const byId = new Map(previous.map((stage) => [stage.id, stage]))
  const bySequence = new Map(previous.map((stage) => [stage.sequence, stage]))
  const used = new Set<string>()
  const ids: (string | null)[] = []
  for (const stage of incoming) {
    if (stage.id && !byId.has(stage.id)) return { ok: false, error: 'A reminder stage no longer belongs to this policy. Refresh Policies and reopen the editor before saving.' }
    const id = stage.id ?? bySequence.get(stage.sequence)?.id ?? null
    if (id && used.has(id)) return { ok: false, error: 'Each reminder stage must appear once. Remove the duplicate stage before saving.' }
    if (id) used.add(id)
    ids.push(id)
  }
  return { ok: true, ids }
}

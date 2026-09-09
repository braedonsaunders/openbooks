/**
 * The two composite cells in the import-history table.
 *
 * Extracted rather than expressed as blocks for the established reason: each
 * is a few lines of one-off composition, and a block per composite would grow
 * the vocabulary without converging. Both render paths import these.
 */

/** Resource name over its optional source filename. */
export function ResourceCell({ label, fileName }: { label: string; fileName: string | null }) {
  return (
    <>
      <div className="font-medium">{label}</div>
      {fileName && <div className="text-xs text-muted-foreground">{fileName}</div>}
    </>
  )
}

/**
 * Row outcome: created / updated / failed, each in its own colour. The failed
 * segment is omitted entirely when nothing failed, which is why this is a
 * component — the spec has no way to express "and this part only sometimes".
 */
export function RowCountsCell({
  created,
  updated,
  failed,
}: {
  created: number
  updated: number
  failed: number
}) {
  return (
    <>
      <span className="text-emerald-600 dark:text-emerald-400">+{created}</span>
      {' / '}
      <span className="text-sky-600 dark:text-sky-400">~{updated}</span>
      {failed > 0 && (
        <>
          {' / '}
          <span className="text-rose-600 dark:text-rose-400">✕{failed}</span>
        </>
      )}
    </>
  )
}

/**
 * Composite cells in the platform email log.
 *
 * Both are a value over an optional second line, which `text` with a suffix
 * cannot express — the suffix is a sibling <div>, not an inline span.
 */

export function EmailSubjectCell({ subject, category }: { subject: string; category: string }) {
  return (
    <>
      <div className="max-w-md truncate font-medium">{subject}</div>
      {category ? <div className="text-xs text-slate-500">{category}</div> : null}
    </>
  )
}

/** Provider and send time, plus the delivery error when one was recorded. */
export function EmailEvidenceCell({ summary, error }: { summary: string; error: string }) {
  return (
    <>
      <div className="text-xs text-slate-500">{summary}</div>
      {error ? (
        <div className="mt-1 max-w-sm break-words text-xs text-red-600 dark:text-red-400">
          {error}
        </div>
      ) : null}
    </>
  )
}

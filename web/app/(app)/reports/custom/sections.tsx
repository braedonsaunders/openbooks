import Link from 'next/link'

/** Report name over its one-line plan summary. */
export function ReportNameCell({
  name,
  href,
  summary,
}: {
  name: string
  href: string
  summary: string
}) {
  return (
    <>
      <Link href={href as never} className="font-medium text-teal-700 hover:underline dark:text-teal-300">
        {name}
      </Link>
      <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{summary}</div>
    </>
  )
}

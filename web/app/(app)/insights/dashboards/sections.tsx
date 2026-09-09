import Link from 'next/link'

/** Dashboard name over its optional description. */
export function DashboardNameCell({
  name,
  href,
  description,
}: {
  name: string
  href: string
  description: string | null
}) {
  return (
    <>
      <Link href={href as never} className="text-teal-700 hover:underline dark:text-teal-300">
        {name}
      </Link>
      {description ? (
        <div className="text-xs font-normal text-slate-500 dark:text-slate-400">{description}</div>
      ) : null}
    </>
  )
}

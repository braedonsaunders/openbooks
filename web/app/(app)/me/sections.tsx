/**
 * Me workspace server-rendered sections: the facts list behind the
 * `hrm-facts` widget. Loader-resolved label/value rows only — no org id,
 * user id, or Authz crosses into render. An empty fact set renders the
 * loader-resolved empty line (a person with no address on file is
 * legitimate) rather than a blank panel pretending to load.
 */
export function HrmFacts({
  facts,
  empty,
}: {
  facts: { label: string; value: string }[]
  empty?: string | null
}) {
  if (facts.length === 0) {
    return empty ? <p className="px-4 py-3 text-sm text-slate-500 dark:text-slate-400">{empty}</p> : null
  }
  return (
    <dl className="divide-y divide-slate-100 dark:divide-slate-800">
      {facts.map((fact) => (
        <div key={fact.label} className="flex items-baseline justify-between gap-4 px-4 py-2.5">
          <dt className="shrink-0 text-sm text-slate-500 dark:text-slate-400">{fact.label}</dt>
          <dd className="text-right text-sm font-medium text-slate-900 tabular-nums dark:text-slate-100">{fact.value}</dd>
        </div>
      ))}
    </dl>
  )
}

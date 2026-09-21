/**
 * Me workspace server-rendered sections: the facts list behind the
 * `hrm-facts` widget. Loader-resolved label/value rows only — no org id,
 * user id, or Authz crosses into render. An empty fact set renders the
 * loader-resolved empty line (a person with no address on file is
 * legitimate) rather than a blank panel pretending to load.
 */
import { UrlDrawer } from '@openbooks/ui'
import type { MeOverviewData } from '../../../lib/hrm/self-service'

type PayExplain = NonNullable<MeOverviewData['payExplain']>;

function TraceTable({ rows, amountLabel }: { rows: { description: string; hours: string | null; rate: string | null; amount: string; treatment: string | null }[]; amountLabel: string }) {
  if (rows.length === 0) return null
  return (
    <table className="w-full text-sm">
      <tbody>
        {rows.map((row) => (
          <tr key={row.description} className="border-t border-slate-100 dark:border-slate-800">
            <td className="py-1 pr-2">
              {row.description}
              {row.hours !== null && row.rate !== null ? (
                <span className="block text-xs text-slate-500 dark:text-slate-400">
                  {row.hours} × {row.rate}
                </span>
              ) : null}
              {row.treatment ? (
                <span className="block text-xs text-slate-500 dark:text-slate-400">{row.treatment}</span>
              ) : null}
            </td>
            <td className="py-1 text-right tabular-nums">{row.amount}</td>
          </tr>
        ))}
      </tbody>
      <caption className="sr-only">{amountLabel}</caption>
    </table>
  )
}

/** The Explain drawer (?explain=<stubId>): the deterministic trace as a
 *  table with diff chips. No LLM is needed — the trace cites record ids
 *  and the figures govern. Renders nothing without an explanation. */
export function ExplainDrawer({ explain }: { explain: PayExplain | null }) {
  if (!explain) return null
  return (
    <UrlDrawer open closeHref={explain.closeHref} title={explain.title}>
      {explain.missing || !explain.trace ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">{explain.missing}</p>
      ) : (
        <div className="space-y-4">
          <dl className="grid grid-cols-3 gap-2 text-sm">
            <div>
              <dt className="text-xs text-slate-500 dark:text-slate-400">{explain.grossLabel}</dt>
              <dd className="font-medium tabular-nums">{explain.trace.gross}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500 dark:text-slate-400">{explain.netLabel}</dt>
              <dd className="font-medium tabular-nums">{explain.trace.netPay}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500 dark:text-slate-400">{explain.employerCostLabel}</dt>
              <dd className="font-medium tabular-nums">{explain.trace.employerCost}</dd>
            </div>
          </dl>
          <section>
            <h3 className="mb-1 text-sm font-medium">{explain.earningsTitle}</h3>
            <TraceTable rows={explain.trace.earnings} amountLabel={explain.earningsTitle} />
          </section>
          <section>
            <h3 className="mb-1 text-sm font-medium">{explain.deductionsTitle}</h3>
            <TraceTable rows={explain.trace.deductions} amountLabel={explain.deductionsTitle} />
          </section>
          {explain.trace.employerContributions.length > 0 ? (
            <section>
              <h3 className="mb-1 text-sm font-medium">{explain.contributionsTitle}</h3>
              <TraceTable rows={explain.trace.employerContributions} amountLabel={explain.contributionsTitle} />
            </section>
          ) : null}
          {explain.trace.diffVsPrevious.changes.length > 0 ? (
            <section>
              <h3 className="mb-1 text-sm font-medium">{explain.diffTitle}</h3>
              <ul className="flex flex-wrap gap-1">
                {explain.trace.diffVsPrevious.changes.map((change) => (
                  <li
                    key={change.description}
                    title={`${change.previousAmount ?? '—'} → ${change.amount ?? '—'}: ${change.input}`}
                    className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-200"
                  >
                    {change.description}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <section>
            <h3 className="mb-1 text-sm font-medium">{explain.sourcesTitle}</h3>
            <ul className="text-xs text-slate-500 dark:text-slate-400">
              {explain.trace.sources.map((source) => (
                <li key={`${source.kind}:${source.id}`}>{source.kind} · {source.id}</li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </UrlDrawer>
  )
}
// HR-21 end: the Explain drawer lives above; HrmFacts follows untouched.
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

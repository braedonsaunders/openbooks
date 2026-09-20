import { UrlDrawer } from '@openbooks/ui'
import { PositionCreateForm } from './PositionCreateForm'
import type { PositionsPageData } from './view'

/**
 * Positions drawer sections (server components): the URL drawer shell around
 * the drawer body with versions, funding by period, and the current holder.
 * The status segments and the vacancy table now render through the shared
 * `filter-chips` widget and the ViewSpec `table` block in ./view, so they
 * live there and not here. Every string arrives loader-resolved as props —
 * no org id, user id, or Authz crosses into render.
 */


export interface PositionDetail {
  code: string
  title: string
  version: string
  effective: string
  recorded: string
  plannedFte: string
  statusLabel: string
  fundingTitle: string
  funding: { period: string; funded: string; costPlan: string | null }[]
  unfunded: string
  holderTitle: string
  holder: string | null
  noHolder: string
  warningsTitle: string
  warnings: string[]
  refusal: string | null
}

/** The position flyout body: version, funding by period, and current holder. */
export function PositionDrawerBody({ detail }: { detail: PositionDetail }) {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          {detail.title} · {detail.plannedFte} FTE · {detail.statusLabel}
        </h3>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{detail.version}</p>
        <p className="text-xs text-slate-500 dark:text-slate-400">{detail.effective}</p>
        <p className="text-xs text-slate-500 dark:text-slate-400">{detail.recorded}</p>
      </div>
      {detail.refusal ? (
        <p role="alert" className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">
          {detail.refusal}
        </p>
      ) : null}
      <div>
        <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{detail.fundingTitle}</h4>
        {detail.funding.length === 0 ? (
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{detail.unfunded}</p>
        ) : (
          <ul className="mt-1 space-y-1.5">
            {detail.funding.map((plan) => (
              <li key={plan.period} className="text-sm text-slate-600 dark:text-slate-300">
                <span className="font-medium">{plan.period}</span>: {plan.funded}
                {plan.costPlan ? ` · ${plan.costPlan}` : null}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{detail.holderTitle}</h4>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          {detail.holder ?? detail.noHolder}
        </p>
      </div>
      {detail.warnings.length > 0 ? (
        <div>
          <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{detail.warningsTitle}</h4>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-600 dark:text-slate-300">
            {detail.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

/**
 * The position flyout shell: a URL drawer around PositionDrawerBody that
 * closes by navigation, or the named absence for a bookmarked id that no
 * longer resolves. Null payload renders nothing — the spec's `when` gate
 * already omits it, so this is the second half of the same guard.
 */
export function PositionDrawer({
  drawer,
}: {
  drawer: {
    closeHref: string
    title: string
    description: string | null
    detail: PositionsPageData['detail']
    missingDetail: string | null
    /** The create form's inputs when the URL asks for a new position. */
    create?: PositionsPageData['create']
  } | null
}) {
  if (!drawer) return null
  return (
    <UrlDrawer
      open
      closeHref={drawer.closeHref}
      title={drawer.title}
      description={drawer.description ?? undefined}
    >
      {drawer.create ? (
        <PositionCreateForm {...drawer.create} />
      ) : drawer.detail ? (
        <PositionDrawerBody detail={drawer.detail} />
      ) : drawer.missingDetail ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">{drawer.missingDetail}</p>
      ) : null}
    </UrlDrawer>
  )
}

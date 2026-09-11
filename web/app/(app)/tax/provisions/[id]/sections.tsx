"use client"

import { Badge } from "@openbooks/ui"

// Single implementation shared by the page and the widget registry: the native page imports
// it from ./ProvisionPostButton and the spec registry reaches it through here.
export { ProvisionPostButton } from "./ProvisionPostButton"

export interface ReconStep {
  key: string
  label: string
  amount: string
  percent: string | null
  isTotal: boolean
  totalLabel: string
}

export interface ProvisionSummary {
  label: string
  value: string
}

/**
 * Rate reconciliation — the ASC 740 headline disclosure.
 *
 * A widget, not a `table` block: the native markup is a bare hand-rolled
 * `<table>` (no card, no hover, no dividers, nonstandard header cells with
 * no padding class) with muted-colour percent cells and a top-bordered bold
 * total row. The ViewSpec table block offers only the two real table
 * variants the app has, so this one stays a component and the spec places
 * it inside its own section (the admin-users precedent).
 *
 * Money and percents arrive loader-formatted — never format here.
 */
export function ProvisionReconSection({
  title,
  pretaxLabel,
  pretaxAmount,
  enactedRateText,
  amountLabel,
  percentLabel,
  steps,
  summaries,
}: {
  title: string
  pretaxLabel: string
  pretaxAmount: string
  enactedRateText: string
  amountLabel: string
  percentLabel: string
  steps: ReconStep[]
  summaries: ProvisionSummary[]
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
      <h2 className="text-sm font-semibold text-slate-900 dark:text-white">{title}</h2>
      <table className="mt-3 w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-slate-500 dark:text-slate-400">
            <th className="py-1" />
            <th className="py-1 text-right">{amountLabel}</th>
            <th className="py-1 text-right">{percentLabel}</th>
          </tr>
        </thead>
        <tbody>
          <tr className="text-slate-500 dark:text-slate-400">
            <td className="py-1.5">{pretaxLabel}</td>
            <td className="py-1.5 text-right tabular-nums">{pretaxAmount}</td>
            <td className="py-1.5 text-right tabular-nums text-slate-400">{enactedRateText}</td>
          </tr>
          {steps.map((step) => (
            <tr
              key={step.key}
              className={step.isTotal ? 'border-t border-slate-200 font-semibold dark:border-slate-700' : ''}
            >
              <td className="py-1.5">{step.isTotal ? step.totalLabel : step.label}</td>
              <td className="py-1.5 text-right tabular-nums">{step.amount}</td>
              <td className="py-1.5 text-right tabular-nums text-slate-500 dark:text-slate-400">
                {step.percent != null ? `${step.percent}%` : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1.5 border-t border-slate-100 pt-3 text-xs dark:border-slate-800">
        {summaries.map((s) => (
          <ProvisionSummaryPair key={s.label} label={s.label} value={s.value} />
        ))}
      </dl>
    </section>
  )
}

function ProvisionSummaryPair({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-right tabular-nums">{value}</dd>
    </>
  )
}

export interface ProvisionDifference {
  id: string
  description: string
  categorySourceLabel: string
  bookBasis: string
  taxBasis: string
  difference: string
  taxEffect: string
}

/**
 * Measured temporary differences — same doctrine as the recon section: the
 * hand-rolled `<table>` is not one of the two real table variants, and the
 * conditional pair (rows vs the italic empty note) cannot cross a spec `when`
 * when the difference COLUMN headers must survive the empty state.
 */
export function ProvisionDifferencesSection({
  title,
  emptyNote,
  columns,
  differences,
}: {
  title: string
  emptyNote: string
  columns: { item: string; bookBasis: string; taxBasis: string; difference: string; effect: string }
  differences: ProvisionDifference[]
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
      <h2 className="text-sm font-semibold text-slate-900 dark:text-white">{title}</h2>
      {differences.length === 0 ? (
        <p className="mt-3 text-sm text-slate-400 italic">{emptyNote}</p>
      ) : (
        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 dark:text-slate-400">
              <th className="py-1">{columns.item}</th>
              <th className="py-1 text-right">{columns.bookBasis}</th>
              <th className="py-1 text-right">{columns.taxBasis}</th>
              <th className="py-1 text-right">{columns.difference}</th>
              <th className="py-1 text-right">{columns.effect}</th>
            </tr>
          </thead>
          <tbody>
            {differences.map((d) => (
              <tr key={d.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="py-1.5">
                  <span className="block">{d.description}</span>
                  <span className="text-xs text-slate-400">{d.categorySourceLabel}</span>
                </td>
                <td className="py-1.5 text-right tabular-nums">{d.bookBasis}</td>
                <td className="py-1.5 text-right tabular-nums">{d.taxBasis}</td>
                <td className="py-1.5 text-right tabular-nums">{d.difference}</td>
                <td className="py-1.5 text-right tabular-nums">{d.taxEffect}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

export function ProvisionStatusBadge({ label, variant }: { label: string; variant: 'success' | 'secondary' | 'outline' }) {
  return <Badge variant={variant}>{label}</Badge>
}

export function ProvisionFrameworkBadge({ label }: { label: string }) {
  return <Badge variant="outline">{label}</Badge>
}

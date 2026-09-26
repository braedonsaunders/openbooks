'use client'

/** Split from RunWizard.tsx; moved without behavior changes. */
import { type StubChange, type StubRow, type AdjustmentRow, type ComponentOption, GENERIC_FACTOR_LABELS, withholding } from './run-wizard-model'
import { HeaderFact } from './run-wizard-controls'
import { Fragment, useState } from 'react'
import { useTranslations } from 'next-intl'
import { AlertTriangle, FileDown, Loader2 } from 'lucide-react'
import { Button, Drawer, FieldHelp, cn } from '@openbooks/ui'
import { MoneyInput, moneyFieldError } from '../../../../../components/money-input'
import { useDirtyClose } from '../../../../../lib/use-dirty-close'
import { type RegisterBucket } from '../../../../../lib/payroll-register-buckets'

/** One employee's stub — the house flyout: header facts, pay lines, the T4127
 * factor trace, and the variance flag, with the paystub PDF one click away.
 *
 * Exported for the exclude-close test: the drawer closes only when the
 * exclusion succeeds, never over a refusal that would strand the typed
 * adjustments with the stub that still holds them. */
export function StubDrawer({
  stub,
  variance,
  change,
  onClose,
  fmt,
  adjustments,
  components,
  canAdjust,
  busy,
  onAdjust,
  buckets,
  regionLabel,
  traceEngines,
  factorLabels,
}: {
  stub: StubRow
  variance: { percent: number; flagged: boolean } | null
  change: StubChange | null
  onClose: () => void
  fmt: (v: string | number | null | undefined) => string
  adjustments: AdjustmentRow[]
  components: ComponentOption[]
  canAdjust: boolean
  /** Parent in-flight mutation state: the add/exclude/remove buttons disable while it runs. */
  busy: boolean
  onAdjust: (body: Record<string, unknown>) => Promise<boolean>
  buckets: RegisterBucket[]
  regionLabel: string
  traceEngines: Record<string, string>
  factorLabels: Record<string, Record<string, string>>
}) {
  const t = useTranslations('payroll')
  const tCommon = useTranslations('common')
  const held = withholding(stub, buckets)
  // The trace heads the filing regime the numbers were computed under
  // (T4127 for CA, Pub 15-T for US) — never a hardcoded country.
  const traceEngine = traceEngines[stub.country ?? ''] ?? Object.values(traceEngines)[0] ?? ''
  const factorEntries = Object.entries(stub.factors ?? {}).sort(([a], [b]) => a.localeCompare(b))
  // Labels resolve through the stub country's pack declaration (server-
  // supplied), then the generic-engine keys, then the raw key — the pack
  // owns its notation, so California's CA_TAX never reads as Canada's CA.
  const stubLabels = factorLabels[stub.country ?? ''] ?? {}
  const factorLabel = (key: string) => {
    const labelled = stubLabels[key] ?? GENERIC_FACTOR_LABELS[key]
    if (labelled !== undefined) return labelled
    if (key.startsWith('PROT_SHORT:')) return key.slice('PROT_SHORT:'.length)
    return key
  }
  const [adjComponent, setAdjComponent] = useState('')
  const [adjAmount, setAdjAmount] = useState('')
  const [adjNote, setAdjNote] = useState('')
  const [adjReplace, setAdjReplace] = useState(false)
  // One idempotency key per form session: a double-clicked Add (or a retried
  // request) reuses it and replays instead of writing twice. Rotated after
  // every SUCCESSFUL add only — a failed attempt keeps its key, so the retry
  // replays instead of duplicating.
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID())
  // A half-typed Add-adjustment draft never closes silently: Escape, the
  // backdrop, the X and Close all funnel through the shared guard, which
  // also refuses to dismiss while the parent mutation is in flight. A clean
  // drawer still closes without prompting; the successful-exclude path below
  // keeps the direct onClose (its work already landed).
  const adjustGuard = useDirtyClose({
    dirty: adjComponent !== '' || adjAmount !== '' || adjNote !== '' || adjReplace,
    busy,
    onClose,
    message: tCommon('feedback.unsavedChanges'),
    confirmLabel: tCommon('confirm.discardChanges'),
  })
  return (
    <Drawer
      open
      onClose={adjustGuard.close}
      title={stub.employee_name}
      description={t('wizard.review.drawerDescription')}
      footer={
        <div className="flex justify-between gap-2">
          <Button variant="outline" asChild>
            <a href={`/api/record-pdf/pay_stub/${stub.id}`} target="_blank" rel="noreferrer">
              <FileDown size={14} aria-hidden />
              {t('wizard.review.downloadPdf')}
            </a>
          </Button>
          <span className="flex items-center gap-2">
            {canAdjust && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void onAdjust({ action: 'exclude-employee', employeePartyId: stub.employee_party_id }).then(
                    (applied) => {
                      // The drawer closes only on success: closing over a
                      // refused exclusion would strand the typed adjustments
                      // with the stub that still holds them.
                      if (applied) onClose()
                    },
                  )
                }
              >
                {t('wizard.adjust.exclude')}
              </Button>
            )}
            <Button variant="ghost" onClick={adjustGuard.close}>
              {t('wizard.review.close')}
            </Button>
          </span>
        </div>
      }
    >
      <div className="space-y-5">
        {variance?.flagged && (
          <div className="flex items-center gap-2 rounded-lg border border-amber-200/80 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-300">
            <AlertTriangle size={14} aria-hidden />
            {t('wizard.review.drawerVariance', {
              percent: `${variance.percent > 0 ? '+' : ''}${variance.percent.toFixed(1)}`,
            })}
          </div>
        )}

        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
          <HeaderFact label={regionLabel}>{stub.province}</HeaderFact>
          <HeaderFact label={t('columns.gross')}>{fmt(stub.gross)}</HeaderFact>
          <HeaderFact label={t('columns.net')}>{fmt(stub.net_pay)}</HeaderFact>
          {buckets.map((bucket, index) => (
            <HeaderFact key={bucket.code} label={bucket.label}>{fmt(held.amounts[index] ?? '0')}</HeaderFact>
          ))}
          <HeaderFact label={t('run.stub.tax')}>{fmt(held.total)}</HeaderFact>
          {variance !== null && (
            <HeaderFact label={t('wizard.review.varianceColumn')}>
              {`${variance.percent > 0 ? '+' : ''}${variance.percent.toFixed(1)}%`}
            </HeaderFact>
          )}
          <HeaderFact label={t('run.employerCost')}>{fmt(stub.employer_cost)}</HeaderFact>
        </dl>

        <div>
          <h4 className="mb-2 text-xs font-semibold tracking-wider text-slate-400 uppercase dark:text-slate-500">
            {t('run.stub.lines')}
          </h4>
          <table className="w-full text-sm">
            <tbody>
              {stub.lines.map((line, index) => (
                <tr key={index} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                  <td className="py-1 pr-2 text-slate-500 dark:text-slate-400">
                    {t(`run.lineKind.${line.kind}`)}
                  </td>
                  <td className="py-1 pr-2">
                    {line.description}
                    {(line.project_name || line.department_name) && (
                      <span className="ml-1 text-xs text-slate-400">
                        {[line.project_name, line.department_name].filter(Boolean).join(' · ')}
                      </span>
                    )}
                  </td>
                  <td className="py-1 pr-2 text-right tabular-nums text-slate-500 dark:text-slate-400">
                    {line.hours ? `${line.hours} × ${fmt(line.rate)}` : ''}
                  </td>
                  <td
                    className={cn(
                      'py-1 text-right tabular-nums',
                      line.kind === 'deduction' && 'text-red-600 dark:text-red-400',
                    )}
                  >
                    {line.kind === 'deduction' ? `−${fmt(line.amount)}` : fmt(line.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {change?.previousPayDate && (
          <div>
            <h4 className="mb-2 text-xs font-semibold tracking-wider text-slate-400 uppercase dark:text-slate-500">
              {t('wizard.review.changedTitle', { date: change.previousPayDate })}
            </h4>
            {change.changes.length === 0 ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">{t('wizard.review.noChangeDetail')}</p>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {change.changes.map((row, index) => (
                    <tr key={index} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                      <td className="py-1 pr-2 text-slate-500 dark:text-slate-400">
                        {t(`wizard.review.changeKind.${row.kind}`)}
                      </td>
                      <td className="py-1 pr-2">{row.component}</td>
                      <td className="py-1 pr-2 text-right tabular-nums text-slate-500 dark:text-slate-400">
                        {row.from === null ? '—' : fmt(row.from)}
                      </td>
                      <td className="py-1 text-right tabular-nums">
                        {row.to === null ? '—' : fmt(row.to)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="mt-2 text-xs text-slate-400 dark:text-slate-500">
              {t('wizard.review.changedTotals', {
                net: fmt(change.netDelta),
                hours: Number(change.hoursDelta).toFixed(2),
              })}
            </p>
          </div>
        )}

        <div>
          <h4 className="mb-2 text-xs font-semibold tracking-wider text-slate-400 uppercase dark:text-slate-500">
            {t('run.stub.trace', { engine: traceEngine })}
          </h4>
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 text-sm">
            {factorEntries.map(([key, value]) => (
              <Fragment key={key}>
                <dt className="text-slate-600 dark:text-slate-300">
                  {factorLabel(key)}
                  <span className="ml-1.5 font-mono text-[10px] text-slate-400 dark:text-slate-500">{key}</span>
                </dt>
                <dd className="text-right tabular-nums">{value}</dd>
              </Fragment>
            ))}
          </dl>
        </div>

        {(canAdjust || adjustments.length > 0) && (
          <div>
            <h4 className="mb-2 text-xs font-semibold tracking-wider text-slate-400 uppercase dark:text-slate-500">
              {t('wizard.adjust.title')}
            </h4>
            {adjustments.length > 0 && (
              <ul className="mb-3 space-y-1 text-sm">
                {adjustments.map((row) => (
                  <li key={row.id} className="flex items-center justify-between gap-2">
                    <span>
                      {row.component_name}
                      {row.replace_component ? ` · ${t('wizard.adjust.replaces')}` : ''}
                      {row.note ? <span className="ml-1.5 text-xs text-slate-400">{row.note}</span> : null}
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="tabular-nums">{fmt(row.amount)}</span>
                      {canAdjust && (
                        <button
                          className="text-xs font-medium text-rose-600 hover:underline dark:text-rose-400 disabled:opacity-50"
                          disabled={busy}
                          onClick={() => void onAdjust({ action: 'delete-adjustment', adjustmentId: row.id })}
                        >
                          {t('wizard.adjust.remove')}
                        </button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {canAdjust && (
              <div className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
                <div className="grid grid-cols-2 gap-2">
                  <select
                    aria-label={t('wizard.adjust.component')}
                    value={adjComponent}
                    onChange={(e) => setAdjComponent(e.target.value)}
                    className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
                  >
                    <option value="">{t('wizard.adjust.component')}</option>
                    <optgroup label={t('wizard.adjust.earnings')}>
                      {components.filter((c) => c.kind === 'earning').map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </optgroup>
                    <optgroup label={t('wizard.adjust.deductions')}>
                      {components.filter((c) => c.kind === 'deduction').map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </optgroup>
                  </select>
                  <MoneyInput
                    ariaLabel={t('wizard.adjust.amount')}
                    value={adjAmount}
                    onChange={setAdjAmount}
                    field={t('wizard.adjust.amount')}
                    noun="a money amount"
                    maxScale={4}
                    required
                    placeholder={t('wizard.adjust.amount')}
                    className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-right text-sm tabular-nums dark:border-slate-700 dark:bg-slate-900"
                  />
                </div>
                <input
                  aria-label={t('wizard.adjust.note')}
                  value={adjNote}
                  onChange={(e) => setAdjNote(e.target.value)}
                  placeholder={t('wizard.adjust.note')}
                  className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
                />
                <span className="flex items-center gap-1.5">
                  <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
                    <input type="checkbox" checked={adjReplace} onChange={(e) => setAdjReplace(e.target.checked)} />
                    {t('wizard.adjust.replace')}
                  </label>
                  <FieldHelp help={t('wizard.adjust.replaceHelp')} />
                </span>
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    disabled={
                      !adjComponent
                      || moneyFieldError(t('wizard.adjust.amount'), 'a money amount', adjAmount, 4, { required: true }) !== null
                      || busy
                    }
                    onClick={() => {
                      void onAdjust({
                        action: 'add-adjustment',
                        employeePartyId: stub.employee_party_id,
                        componentId: adjComponent,
                        amount: adjAmount,
                        note: adjNote || undefined,
                        replaceComponent: adjReplace,
                        idempotencyKey: requestKey,
                      }).then((added) => {
                        if (!added) return
                        setAdjComponent(''); setAdjAmount(''); setAdjNote(''); setAdjReplace(false)
                        setRequestKey(crypto.randomUUID())
                      })
                    }}
                  >
                    {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null}
                    {busy ? tCommon('actions.saving') : t('wizard.adjust.add')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </Drawer>
  )
}

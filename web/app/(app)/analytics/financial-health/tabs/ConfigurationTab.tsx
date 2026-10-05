'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Info, Layers, X } from 'lucide-react'
import { Button, SearchSelect } from '@openbooks/ui'
import type { HealthBenchmarks, RatioInputKey } from '../../../../../lib/analytics/financial-health'
import type { RatioInputAccount, RatioInputState } from '../../../../../lib/analytics/ratio-inputs'
import { readApiErrorMessage } from '../../../../../lib/api-error'
import { Panel } from '../../_ui/Panel'
import { ConfigEditor } from '../../_ui/ConfigEditor'
import { useRatioFormat } from '../../_ui/format'

const INPUT_KEYS: RatioInputKey[] = ['interest_expense', 'interest_bearing_debt']

/**
 * Configuration — the targets, grading policy and finding thresholds behind
 * the Ratios tab and the health score, and the account classifications the
 * leverage ratios read. Saving recomputes every grade.
 */
export function ConfigurationTab({ canEdit, benchmarks }: { canEdit: boolean; benchmarks: HealthBenchmarks }) {
  const t = useTranslations('analytics.financialHealth')
  const format = useRatioFormat()
  const g = benchmarks.grades
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <ConfigEditor dashboard="financialHealth" canEdit={canEdit} />
      <div className="space-y-5">
        <Panel title={t('grading.title')} icon={Info}>
          <div className="space-y-2 text-sm text-slate-600 dark:text-slate-300">
            <p>
              {t('grading.body', {
                a: format(g.a, 'pct') ?? '',
                b: format(g.b, 'pct') ?? '',
                c: format(g.c, 'pct') ?? '',
                d: format(g.d, 'pct') ?? '',
              })}
            </p>
            <p className="text-slate-500 dark:text-slate-400">
              {t('grading.labels', {
                excellent: benchmarks.labels.excellent,
                good: benchmarks.labels.good,
                average: benchmarks.labels.average,
              })}
            </p>
          </div>
        </Panel>
        <RatioInputsPanel canEdit={canEdit} />
      </div>
    </div>
  )
}

function accountLabel(a: RatioInputAccount): string {
  return [a.number, a.name].filter(Boolean).join(' · ')
}

/** Which accounts hold interest expense and interest-bearing debt — the organization's own answer. */
function RatioInputsPanel({ canEdit }: { canEdit: boolean }) {
  const t = useTranslations('analytics.financialHealth.ratioInputs')
  const router = useRouter()
  const [inputs, setInputs] = useState<Record<RatioInputKey, RatioInputState> | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch('/api/analytics/financial-health/ratio-inputs')
        if (!res.ok) {
          const message = await readApiErrorMessage(res, t('loadFailed'))
          if (!cancelled) setError(message)
          return
        }
        const body = (await res.json()) as { inputs: Record<RatioInputKey, RatioInputState> }
        if (!cancelled) setInputs(body.inputs)
      } catch {
        if (!cancelled) setError(t('loadFailed'))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [t])

  return (
    <Panel title={t('title')} icon={Layers} hint={t('hint')}>
      {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
      {inputs ? (
        <div className="space-y-5">
          {INPUT_KEYS.map((key) => (
            <ClassificationEditor
              key={key}
              inputKey={key}
              state={inputs[key]}
              canEdit={canEdit}
              onSaved={(accounts) => {
                setInputs((prev) => (prev ? { ...prev, [key]: { ...prev[key], accounts } } : prev))
                router.refresh()
              }}
            />
          ))}
        </div>
      ) : null}
    </Panel>
  )
}

function ClassificationEditor({
  inputKey,
  state,
  canEdit,
  onSaved,
}: {
  inputKey: RatioInputKey
  state: RatioInputState
  canEdit: boolean
  onSaved: (accounts: RatioInputAccount[]) => void
}) {
  const t = useTranslations('analytics.financialHealth.ratioInputs')
  const [draft, setDraft] = useState<RatioInputAccount[]>(state.accounts ?? [])
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const chosen = new Set(draft.map((a) => a.id))
  const decided = state.accounts !== null
  const dirty = !decided || draft.length !== state.accounts!.length || draft.some((a) => !state.accounts!.some((b) => b.id === a.id))

  const save = async () => {
    setSaving(true)
    setMessage(null)
    try {
      const res = await fetch('/api/analytics/financial-health/ratio-inputs', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: inputKey, accountIds: draft.map((a) => a.id) }),
      })
      if (!res.ok) {
        setMessage(await readApiErrorMessage(res, t('saveFailed')))
        return
      }
      const body = (await res.json()) as { accounts: RatioInputAccount[] }
      setDraft(body.accounts)
      onSaved(body.accounts)
      setMessage(t('saved'))
    } catch {
      setMessage(t('saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section>
      <h4 className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t(`${inputKey}.title`)}</h4>
      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{t(`${inputKey}.help`)}</p>
      {!decided ? <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">{t('notDecided')}</p> : null}
      <ul className="mt-2 flex flex-wrap gap-1.5">
        {draft.length === 0 && decided ? <li className="text-xs text-slate-400 dark:text-slate-500">{t(`${inputKey}.none`)}</li> : null}
        {draft.map((a) => (
          <li key={a.id} className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">
            {accountLabel(a)}
            {canEdit ? (
              <button type="button" aria-label={t('remove', { account: accountLabel(a) })} onClick={() => setDraft((d) => d.filter((x) => x.id !== a.id))} className="text-slate-400 hover:text-slate-600">
                <X size={12} />
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {canEdit ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <div className="min-w-[14rem] flex-1">
            <SearchSelect
              value=""
              placeholder={t('add')}
              options={state.candidates.filter((a) => !chosen.has(a.id)).map((a) => ({ value: a.id, label: accountLabel(a) }))}
              onChange={(id: string) => {
                const account = state.candidates.find((a) => a.id === id)
                if (account) setDraft((d) => [...d, account])
              }}
            />
          </div>
          <Button size="sm" disabled={saving || !dirty} onClick={() => void save()}>
            {draft.length === 0 ? t(`${inputKey}.confirmNone`) : t('save')}
          </Button>
          {message ? <span className="text-xs text-slate-500 dark:text-slate-400">{message}</span> : null}
        </div>
      ) : null}
    </section>
  )
}

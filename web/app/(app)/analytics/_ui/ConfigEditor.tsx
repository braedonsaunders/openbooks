'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { Settings2 } from 'lucide-react'
import { Skeleton } from '@openbooks/ui'
import { Panel } from './Panel'
import { readApiErrorMessage } from '../../../../lib/api-error'
import { useAppAction } from '../../../../lib/use-app-action'
import { ActionError } from '@braedonsaunders/appkit-errors'
import type { AnalyticsConfigValues, ConfigField } from '../../../../lib/analytics/config-spec'

/**
 * Editable analytics thresholds — the Configuration-tab save flow.
 *
 * The editor owns no field list: it renders the single specification served
 * by GET /api/analytics/config/<dashboard> (fields, kinds, defaults, the
 * presentation currency and the revision), PUTs whole-object overrides back,
 * then refreshes the server-rendered dashboard so every tab recomputes.
 * Money thresholds are exact decimal text labelled with the presentation
 * currency; the server refuses unreadable amounts by name.
 */
interface ConfigPayload {
  fields: ConfigField[]
  groups?: { labelKey: string; fields: string[] }[]
  values: AnalyticsConfigValues
  defaults: AnalyticsConfigValues
  currency: string
  revision: number
}

function asDraft(fields: ConfigField[], values: AnalyticsConfigValues, defaults: AnalyticsConfigValues): Record<string, string> {
  return Object.fromEntries(fields.map((f) => [f.key, String(values[f.key] ?? defaults[f.key] ?? '')]))
}

function sameValue(field: ConfigField, a: string, b: string): boolean {
  if (field.kind === 'money' || field.kind === 'select') return a.trim() === b.trim()
  return Number(a) === Number(b)
}

export function ConfigEditor({
  dashboard,
  onDirtyChange,
  canEdit,
}: {
  dashboard: string
  /** Reports unsaved-edit state so hosts (drawers) can guard dismissal. */
  onDirtyChange?: (dirty: boolean) => void
  /** admin.setup.manage with unrestricted scope (the PUT's gate). Without
   * it the thresholds render read-only: showing an editor that can only
   * 403 invites edits that can never save. */
  canEdit: boolean
}) {
  const t = useTranslations()
  const te = useTranslations('analytics.configEditor')
  const locale = useLocale()
  // A select option label: catalog text, unless the spec declares the
  // options locale-formatted (percent codes like 90 render in the viewer's
  // own percent shape, never from a hard-coded "%" string).
  const optionLabel = (f: ConfigField, option: string) => {
    if (f.optionsFormat === 'percent') {
      const whole = Number(option)
      if (Number.isFinite(whole)) return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(whole / 100)
    }
    return f.optionsKey ? t(`${f.optionsKey}.${option}`) : option
  }
  const router = useRouter()
  const [config, setConfig] = useState<ConfigPayload | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const { busy, execute } = useAppAction()
  const [msg, setMsg] = useState<string | null>(null)

  const adopt = useCallback((payload: ConfigPayload) => {
    setConfig(payload)
    setDraft(asDraft(payload.fields, payload.values, payload.defaults))
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const r = await fetch(`/api/analytics/config/${dashboard}`)
        if (!r.ok) {
          const message = await readApiErrorMessage(r, te('loadFailed'))
          if (!cancelled) setLoadError(message)
          return
        }
        const body = (await r.json()) as ConfigPayload
        if (!cancelled) adopt(body)
      } catch {
        if (!cancelled) setLoadError(te('loadFailed'))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [dashboard, adopt, te])

  const fields = config?.fields ?? []
  const dirty = !!config && fields.some((f) => !sameValue(f, draft[f.key] ?? '', String(config.values[f.key] ?? config.defaults[f.key] ?? '')))

  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  const save = async (payload: Record<string, string | number>) => {
    if (!config) return
    setMsg(null)
    await execute(async () => {
      try {
        const r = await fetch(`/api/analytics/config/${dashboard}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expectedRevision: config.revision, values: payload }),
        })
        if (r.ok) {
          const body = (await r.json()) as { revision?: unknown; values?: AnalyticsConfigValues }
          adopt({ ...config, values: body.values ?? config.values, revision: typeof body.revision === 'number' ? body.revision : config.revision })
          setMsg(te('saved'))
          router.refresh()
        } else if (r.status === 409) {
          // Another admin committed first: adopt the latest values (the
          // conflicting edit is not saved) and name the remedy.
          let body: { error?: unknown; revision?: unknown; values?: unknown } | null = null
          try {
            body = (await r.json()) as { error?: unknown; revision?: unknown; values?: unknown } | null
          } catch {
            body = null
          }
          if (body?.values && typeof body.values === 'object') {
            adopt({
              ...config,
              values: body.values as AnalyticsConfigValues,
              revision: typeof body.revision === 'number' ? body.revision : config.revision,
            })
          }
          setMsg(typeof body?.error === 'string' && body.error ? body.error : te('conflict'))
          router.refresh()
        } else if (r.status === 403) {
          // The PUT needs admin.setup.manage AND unrestricted scope: a
          // scoped admin holds the permission yet is still refused, so the
          // server's reason leads and the generic line is only the fallback.
          setMsg(await readApiErrorMessage(r, te('forbidden')))
        } else {
          setMsg(await readApiErrorMessage(r, te('saveFailed')))
        }
        return { ok: true as const, status: r.status, data: null }
      } catch {
        // Network and unreadable-success-body failures must release busy and
        // leave the operator a visible retryable refusal.
        return {
          ok: false as const,
          error: new ActionError({ kind: 'transport', serverMessage: te('saveFailed') }),
        }
      }
    }, {
      fallbackMessage: te('saveFailed'),
      onRefused: (error) => setMsg(error.displayMessage(te('saveFailed'))),
    })
  }

  const payloadFrom = (source: Record<string, string>) =>
    Object.fromEntries(fields.map((f) => [f.key, source[f.key] ?? '']))

  if (loadError) {
    return (
      <Panel title={te('title')} icon={Settings2}>
        <p className="text-sm text-red-600 dark:text-red-400">{loadError}</p>
      </Panel>
    )
  }
  if (!config) {
    return (
      <Panel title={te('title')} icon={Settings2}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-14 w-full" />)}
        </div>
      </Panel>
    )
  }

  const label = (key: string) => t(key, { currency: config.currency })
  // Declared sections first, in order; any field in no section renders last.
  const grouped = new Set((config.groups ?? []).flatMap((g) => g.fields))
  const byKey = new Map(fields.map((f) => [f.key, f]))
  const sections: { labelKey: string | null; fields: ConfigField[] }[] = [
    ...(config.groups ?? []).map((g) => ({ labelKey: g.labelKey, fields: g.fields.map((k) => byKey.get(k)).filter((f): f is ConfigField => !!f) })),
    { labelKey: null, fields: fields.filter((f) => !grouped.has(f.key)) },
  ].filter((section) => section.fields.length > 0)
  const defaultText = (f: ConfigField) => {
    const value = config.defaults[f.key]
    if (value === '' || value === undefined) return te('notSet')
    if (f.kind === 'toggle') return value === 1 ? te('on') : te('off')
    if (f.kind === 'select' && (f.optionsKey || f.optionsFormat)) return optionLabel(f, value)
    return String(value)
  }

  return (
    <Panel title={te('title')} icon={Settings2} hint={te('hint')}>
      {sections.map((section, i) => (
        <section key={section.labelKey ?? `rest-${i}`} className={i > 0 ? 'mt-5 border-t border-slate-100 pt-4 dark:border-slate-800' : undefined}>
          {section.labelKey ? (
            <h4 className="mb-3 text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">{label(section.labelKey)}</h4>
          ) : null}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {section.fields.map((f) => (
              <label key={f.key} className="block">
                <span className="flex items-baseline justify-between gap-2 text-xs font-medium text-slate-600 dark:text-slate-300">
                  {label(f.labelKey)}
                  <span className="shrink-0 font-normal text-slate-400 dark:text-slate-500">{te('default', { value: defaultText(f) })}</span>
                </span>
                {f.kind === 'toggle' ? (
                  <input
                    type="checkbox"
                    checked={draft[f.key] === '1'}
                    disabled={!canEdit}
                    onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.checked ? '1' : '0' }))}
                    className="mt-2 h-4 w-4 rounded border-slate-300 text-teal-600 disabled:opacity-60 dark:border-slate-600"
                  />
                ) : f.kind === 'select' ? (
                  <select
                    value={draft[f.key]}
                    disabled={!canEdit}
                    onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                    className="mt-1 h-8 w-full rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-700 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200"
                  >
                    {(f.options ?? []).map((option) => (
                      <option key={option} value={option}>{optionLabel(f, option)}</option>
                    ))}
                  </select>
                ) : f.kind === 'money' ? (
                  <span className="mt-1 flex items-center gap-1.5">
                    <input
                      type="text"
                      inputMode="decimal"
                      value={draft[f.key]}
                      placeholder={f.optional ? te('notSet') : undefined}
                      disabled={!canEdit}
                      onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                      className="h-8 w-full rounded-md border border-slate-200 bg-white px-2 text-right text-sm text-slate-700 tabular-nums disabled:opacity-60 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200"
                    />
                    <span className="shrink-0 text-xs font-medium text-slate-500 dark:text-slate-400">{config.currency}</span>
                  </span>
                ) : (
                  <input
                    type="number"
                    value={draft[f.key]}
                    min={f.min}
                    max={f.max}
                    step={f.step}
                    disabled={!canEdit}
                    onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                    className="mt-1 h-8 w-full rounded-md border border-slate-200 bg-white px-2 text-right text-sm text-slate-700 tabular-nums disabled:opacity-60 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200"
                  />
                )}
                <span className="mt-0.5 block text-[11px] leading-snug text-slate-400 dark:text-slate-500">{label(f.helpKey)}</span>
              </label>
        ))}
          </div>
        </section>
      ))}
      <div className="mt-4 flex items-center gap-2">
        {canEdit ? (
          <>
            <button
              type="button"
              disabled={busy || !dirty}
              onClick={() => save(payloadFrom(draft))}
              className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40 hover:bg-teal-700"
            >
              {te('save')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                const defaults = asDraft(fields, config.defaults, config.defaults)
                setDraft(defaults)
                void save(payloadFrom(defaults))
              }}
              className="rounded-md border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              {te('reset')}
            </button>
          </>
        ) : (
          <span className="text-xs text-slate-400 dark:text-slate-500">{te('readOnly')}</span>
        )}
        {msg ? <span className="text-xs text-slate-400 dark:text-slate-500">{msg}</span> : null}
      </div>
    </Panel>
  )
}

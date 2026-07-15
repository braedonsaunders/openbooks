'use client'

// Reactive AI settings form, ported from beaconhs's ai-settings/settings-form:
// the provider selector drives the base-URL field, the API-key hint and the
// model dropdowns; model lists are fetched live from the provider's API via
// the server (the key never reaches the browser). Adapted to openbooks' API-
// route convention (no server actions) and single-org scope (no platform
// policy selector, no journal-automation toggle).

import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { CheckCircle2, Loader2, RefreshCw, XCircle, Zap } from 'lucide-react'
import { toast } from 'sonner'
import { Button, Input, Label, SearchSelect, cn, type SelectOption } from '@openbooks/ui'

// Serializable slice of a provider spec (no SDK code reaches the client bundle).
export type ProviderSpecLite = {
  value: string
  label: string
  baseUrl: string | null
  requiresBaseUrl: boolean
  fast: string
  smart: string
  keyHint: string
  modelHint?: string
}

type AiFormInitial = {
  enabled: boolean
  provider: string
  modelFast: string
  modelSmart: string
  baseUrl: string
  hasKey: boolean
}

type ModelListItem = { id: string; label?: string }

export function AiSettingsForm({
  specs,
  initial,
}: {
  specs: ProviderSpecLite[]
  initial: AiFormInitial
}) {
  const t = useTranslations('admin.ai')
  const [enabled, setEnabled] = useState(initial.enabled)
  const [provider, setProvider] = useState(initial.provider)
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl)
  const [modelFast, setModelFast] = useState(initial.modelFast)
  const [modelSmart, setModelSmart] = useState(initial.modelSmart)
  const [hasKey, setHasKey] = useState(initial.hasKey)
  const [savedProviderValue, setSavedProviderValue] = useState(initial.provider)

  const [models, setModels] = useState<ModelListItem[]>([])
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [manual, setManual] = useState(false)
  const [loading, startLoad] = useTransition()
  const [saving, startSave] = useTransition()
  const [testing, startTest] = useTransition()
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const modelRequestId = useRef(0)

  const requestModels = useCallback(
    (requestedProvider: string, key: string, requestedBaseUrl: string) => {
      const requestId = ++modelRequestId.current
      startLoad(async () => {
        try {
          const res = await fetch('/api/admin/ai/models', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              provider: requestedProvider,
              baseUrl: requestedBaseUrl,
              apiKey: key,
            }),
          })
          const result = (await res.json()) as {
            ok: boolean
            models: ModelListItem[]
            message?: string
          }
          if (requestId !== modelRequestId.current) return
          if (result.ok) {
            setModels(result.models)
            setModelsError(null)
          } else {
            setModels([])
            setModelsError(result.message ?? t('models.loadError'))
          }
        } catch {
          if (requestId !== modelRequestId.current) return
          setModels([])
          setModelsError(t('models.loadError'))
        }
      })
      return requestId
    },
    [t],
  )

  // Auto-load the saved provider's models on first render (a key is on file).
  useEffect(() => {
    if (!initial.hasKey) return
    const requestId = requestModels(initial.provider, '', initial.baseUrl)
    return () => {
      if (modelRequestId.current === requestId) modelRequestId.current += 1
    }
  }, [initial.baseUrl, initial.hasKey, initial.provider, requestModels])

  const spec = specs.find((s) => s.value === provider) ?? specs[0]
  if (!spec) return null
  const showBaseUrl = spec.requiresBaseUrl || spec.baseUrl !== null
  const savedProvider = provider === savedProviderValue

  function invalidateModels() {
    modelRequestId.current += 1
    setModels([])
    setModelsError(null)
  }

  function onProviderChange(next: string) {
    invalidateModels()
    setProvider(next)
    // Carry saved values only when switching back to the saved provider.
    const isSaved = next === savedProviderValue
    setModelFast(isSaved ? initial.modelFast : '')
    setModelSmart(isSaved ? initial.modelSmart : '')
    setBaseUrl(isSaved ? initial.baseUrl : '')
    setManual(false)
  }

  function save() {
    startSave(async () => {
      try {
        const res = await fetch('/api/admin/ai', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            enabled,
            provider,
            modelFast,
            modelSmart,
            baseUrl,
            apiKey: apiKey || undefined,
          }),
        })
        const body = (await res.json()) as AiFormInitial & { error?: string }
        if (!res.ok) {
          toast.error(body.error ?? t('saveFailed'))
          return
        }
        setHasKey(body.hasKey)
        setSavedProviderValue(body.provider)
        setApiKey('')
        setTestResult(null)
        toast.success(t('saved'))
      } catch {
        toast.error(t('saveFailed'))
      }
    })
  }

  function clearKey() {
    startSave(async () => {
      try {
        const res = await fetch('/api/admin/ai', { method: 'DELETE' })
        if (!res.ok) throw new Error()
        setHasKey(false)
        setTestResult(null)
        invalidateModels()
        toast.success(t('keyCleared'))
      } catch {
        toast.error(t('saveFailed'))
      }
    })
  }

  function test() {
    startTest(async () => {
      try {
        const res = await fetch('/api/admin/ai/test', { method: 'POST' })
        setTestResult((await res.json()) as { ok: boolean; message: string })
      } catch {
        setTestResult({ ok: false, message: t('testFailed') })
      }
    })
  }

  const keyPlaceholder =
    hasKey && savedProvider ? t('keySavedPlaceholder') : spec.keyHint || t('keyPlaceholder')

  function modelOptions(value: string): SelectOption[] {
    const opts: SelectOption[] = models.map((m) => ({
      value: m.id,
      label: m.label ? `${m.label} — ${m.id}` : m.id,
    }))
    // Keep a saved/typed value selectable even if the live list lacks it.
    if (value && !models.some((m) => m.id === value)) {
      opts.unshift({ value, label: t('models.current', { id: value }) })
    }
    return opts
  }

  function modelField(opts: {
    label: string
    hint: string
    value: string
    setValue: (v: string) => void
    placeholder: string
  }) {
    return (
      <div className="space-y-1.5">
        <Label>
          {opts.label}{' '}
          <span className="font-normal text-slate-400 dark:text-slate-500">({opts.hint})</span>
        </Label>
        {manual ? (
          <Input
            value={opts.value}
            onChange={(e) => opts.setValue(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder={opts.placeholder}
          />
        ) : (
          <SearchSelect
            value={opts.value}
            onChange={opts.setValue}
            options={modelOptions(opts.value)}
            disabled={!models.length && !opts.value}
            clearable
            emptyLabel={t('models.none')}
            placeholder={models.length ? t('models.pick') : t('models.loadFirst')}
            sheetTitle={opts.label}
            ariaLabel={opts.label}
          />
        )}
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <label className="flex items-center gap-2.5">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500 dark:border-slate-600"
        />
        <span className="text-sm font-medium text-slate-800 dark:text-slate-100">
          {t('enabledLabel')}
        </span>
      </label>

      <div className="space-y-1.5">
        <Label>{t('providerLabel')}</Label>
        <SearchSelect
          value={provider}
          onChange={onProviderChange}
          options={specs.map((s) => ({ value: s.value, label: s.label }))}
          sheetTitle={t('providerLabel')}
          ariaLabel={t('providerLabel')}
        />
      </div>

      {showBaseUrl ? (
        <div className="space-y-1.5">
          <Label>
            {t('baseUrlLabel')}{' '}
            <span className="font-normal text-slate-400 dark:text-slate-500">
              {spec.requiresBaseUrl ? t('baseUrlRequired') : t('baseUrlOptional')}
            </span>
          </Label>
          <Input
            value={baseUrl}
            onChange={(e) => {
              invalidateModels()
              setBaseUrl(e.target.value)
            }}
            autoComplete="off"
            spellCheck={false}
            placeholder={spec.baseUrl ?? 'https://your-endpoint/v1'}
          />
          <p className="text-xs text-slate-400 dark:text-slate-500">
            {spec.baseUrl ? t('baseUrlDefault', { url: spec.baseUrl }) : t('baseUrlHint')}
          </p>
        </div>
      ) : null}

      <div className="space-y-1.5">
        <Label>{t('keyLabel')}</Label>
        <Input
          type="password"
          value={apiKey}
          onChange={(e) => {
            invalidateModels()
            setApiKey(e.target.value)
          }}
          autoComplete="off"
          placeholder={keyPlaceholder}
        />
        <p className="text-xs text-slate-400 dark:text-slate-500">
          {hasKey && savedProvider ? t('keySavedHint') : t('keyHint')}
        </p>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>{t('modelsLabel')}</Label>
          <div className="flex items-center gap-3 text-xs">
            <button
              type="button"
              onClick={() => setManual((m) => !m)}
              className="text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-300"
            >
              {manual ? t('models.pickFromList') : t('models.typeManually')}
            </button>
            <button
              type="button"
              onClick={() => requestModels(provider, apiKey, baseUrl)}
              disabled={loading}
              className="inline-flex items-center gap-1 font-medium text-teal-600 hover:text-teal-700 disabled:opacity-50"
            >
              {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              {loading ? t('models.loading') : models.length ? t('models.reload') : t('models.load')}
            </button>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {modelField({
            label: t('fastModelLabel'),
            hint: t('fastModelHint'),
            value: modelFast,
            setValue: setModelFast,
            placeholder: spec.fast || t('models.idPlaceholder'),
          })}
          {modelField({
            label: t('smartModelLabel'),
            hint: t('smartModelHint'),
            value: modelSmart,
            setValue: setModelSmart,
            placeholder: spec.smart || t('models.idPlaceholder'),
          })}
        </div>
        {modelsError ? (
          <p className="text-xs text-amber-600">{modelsError}</p>
        ) : models.length ? (
          <p className="text-xs text-slate-400 dark:text-slate-500">
            {t('models.loaded', { count: models.length })}
          </p>
        ) : (
          <p className="text-xs text-slate-400 dark:text-slate-500">
            {spec.modelHint ?? t('models.hint')}
          </p>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
        <Button type="button" onClick={save} disabled={saving}>
          {saving ? <Loader2 size={14} className="animate-spin" /> : null}
          {t('save')}
        </Button>
      </div>

      <div className="flex items-start justify-between gap-4 border-t border-slate-100 pt-4 dark:border-slate-800">
        <div className="space-y-2">
          <Button type="button" variant="outline" disabled={testing} onClick={test}>
            {testing ? (
              <Loader2 size={14} className="mr-1.5 animate-spin" />
            ) : (
              <Zap size={14} className="mr-1.5" />
            )}
            {t('testConnection')}
          </Button>
          {testResult ? (
            <div
              className={cn(
                'flex items-start gap-2 rounded-md border p-2.5 text-sm',
                testResult.ok
                  ? 'border-teal-200 bg-teal-50 text-teal-800 dark:border-teal-800/60 dark:bg-teal-950/50 dark:text-teal-200'
                  : 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300',
              )}
            >
              {testResult.ok ? (
                <CheckCircle2 size={15} className="mt-px shrink-0" />
              ) : (
                <XCircle size={15} className="mt-px shrink-0" />
              )}
              <span>{testResult.message}</span>
            </div>
          ) : null}
        </div>
        {hasKey ? (
          <Button type="button" variant="ghost" className="text-red-600" onClick={clearKey} disabled={saving}>
            {t('removeKey')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

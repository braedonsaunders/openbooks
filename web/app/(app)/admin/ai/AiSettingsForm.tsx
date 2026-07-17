'use client'

// Reactive AI settings form, ported from beaconhs's ai-settings/settings-form:
// the provider selector drives the base-URL field, the API-key hint and the
// model dropdowns; model lists are fetched live from the provider's API via
// the server (the key never reaches the browser). Adapted to openbooks' API-
// route convention (no server actions) and single-org scope (no platform
// policy selector, no journal-automation toggle).

import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { Activity, CheckCircle2, ChevronRight, FileScan, Loader2, Play, RefreshCw, RotateCcw, SlidersHorizontal, XCircle, Zap } from 'lucide-react'
import { toast } from 'sonner'
import { Badge, Button, Input, Label, SearchSelect, Select, UrlDrawer, cn, type SelectOption } from '@openbooks/ui'

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
  agents: AgentPolicy[]
  documentCapture: DocumentCapturePolicy
}

type DocumentCapturePolicy = {
  enabled: boolean
  provider: 'azure_document_intelligence'
  endpoint: string
  model: string
  confidenceThreshold: string
  autoCreatePoMatchedDrafts: boolean
  hasKey: boolean
}

type AgentPolicy = {
  id: string | null
  agentKey: 'accounting' | 'finance'
  enabled: boolean
  automaticRuns: boolean
  cadence: 'daily' | 'weekly'
  materialityThreshold: string
  detectors: DetectorPolicy[]
  analysis: {
    rootCauseAnalysis: boolean
    recommendations: boolean
    narrative: boolean
    modelTier: 'fast' | 'smart'
    maxToolSteps: number
  }
  lastRunAt: string | null
  nextRunAt: string | null
  lastRunStatus: 'completed' | 'failed' | 'skipped' | 'running' | null
}

type DetectorPolicy = {
  detectorKey: string
  enabled: boolean
  materialityThreshold: string | null
  parameters: Record<string, number>
}

export type DetectorParameterSpecLite = {
  key: string
  defaultValue: number
  min: number
  max: number
  step: number
  unit: 'days' | 'count' | 'percent' | 'multiple' | 'points'
}

export type DetectorSpecLite = {
  detectorKey: string
  agentKey: AgentPolicy['agentKey']
  supportsMateriality: boolean
  parameters: DetectorParameterSpecLite[]
}

type ModelListItem = { id: string; label?: string }

export function AiSettingsForm({ specs, detectorSpecs, initial, selectedAgentKey }: { specs: ProviderSpecLite[]; detectorSpecs: DetectorSpecLite[]; initial: AiFormInitial; selectedAgentKey: AgentPolicy['agentKey'] | null }) {
  const t = useTranslations('admin.ai')
  const locale = useLocale()
  const [enabled, setEnabled] = useState(initial.enabled)
  const [provider, setProvider] = useState(initial.provider)
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl)
  const [modelFast, setModelFast] = useState(initial.modelFast)
  const [modelSmart, setModelSmart] = useState(initial.modelSmart)
  const [hasKey, setHasKey] = useState(initial.hasKey)
  const [savedProviderValue, setSavedProviderValue] = useState(initial.provider)
  const [agents, setAgents] = useState<AgentPolicy[]>(initial.agents)
  const [runningAgent, setRunningAgent] = useState<string | null>(null)
  const [documentCapture, setDocumentCapture] = useState(initial.documentCapture)
  const [documentCaptureKey, setDocumentCaptureKey] = useState('')
  const [testingCapture, startCaptureTest] = useTransition()
  const [captureTestResult, setCaptureTestResult] = useState<{ ok: boolean; code: 'connected' | 'failed' | 'missing' } | null>(null)
  const selectedAgent = selectedAgentKey ? (agents.find((agent) => agent.agentKey === selectedAgentKey) ?? null) : null

  const [models, setModels] = useState<ModelListItem[]>([])
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [manual, setManual] = useState(false)
  const [loading, startLoad] = useTransition()
  const [saving, startSave] = useTransition()
  const [testing, startTest] = useTransition()
  const [testResult, setTestResult] = useState<{
    ok: boolean
    message: string
  } | null>(null)
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
            agents,
            documentCapture: { ...documentCapture, apiKey: documentCaptureKey || undefined },
          }),
        })
        const body = (await res.json()) as AiFormInitial & { error?: string }
        if (!res.ok) {
          toast.error(body.error ?? t('saveFailed'))
          return
        }
        setHasKey(body.hasKey)
        setSavedProviderValue(body.provider)
        setAgents(body.agents)
        setDocumentCapture(body.documentCapture)
        setDocumentCaptureKey('')
        setApiKey('')
        setTestResult(null)
        toast.success(t('saved'))
      } catch {
        toast.error(t('saveFailed'))
      }
    })
  }

  function updateAgent(agentKey: AgentPolicy['agentKey'], patch: Partial<AgentPolicy>) {
    setAgents((current) => current.map((agent) => (agent.agentKey === agentKey ? { ...agent, ...patch } : agent)))
  }

  async function runAgent(agentKey: AgentPolicy['agentKey']) {
    setRunningAgent(agentKey)
    try {
      // Persist the visible policy first so Run now always executes exactly the
      // controls the administrator is looking at.
      const saveResponse = await fetch('/api/admin/ai', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          enabled,
          provider,
          modelFast,
          modelSmart,
          baseUrl,
          apiKey: apiKey || undefined,
          agents,
          documentCapture: { ...documentCapture, apiKey: documentCaptureKey || undefined },
        }),
      })
      const saved = (await saveResponse.json()) as AiFormInitial & {
        error?: string
      }
      if (!saveResponse.ok) throw new Error(saved.error ?? 'save_failed')
      setAgents(saved.agents)
      setDocumentCapture(saved.documentCapture)
      setDocumentCaptureKey('')
      setHasKey(saved.hasKey)
      setApiKey('')
      const response = await fetch('/api/continuous-close/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentKey }),
      })
      const result = (await response.json()) as {
        detected?: number
        autoResolved?: number
      }
      if (!response.ok) throw new Error('scan_failed')
      toast.success(
        t('agents.scanComplete', {
          detected: result.detected ?? 0,
          resolved: result.autoResolved ?? 0,
        }),
      )
      const refreshed = (await fetch('/api/admin/ai').then((res) => res.json())) as AiFormInitial
      setAgents(refreshed.agents)
    } catch {
      toast.error(t('agents.scanFailed'))
    } finally {
      setRunningAgent(null)
    }
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

  function testDocumentCapture() {
    startCaptureTest(async () => {
      try {
        const response = await fetch('/api/admin/ai/document-capture/test', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            endpoint: documentCapture.endpoint,
            model: documentCapture.model,
            apiKey: documentCaptureKey || undefined,
          }),
        })
        setCaptureTestResult((await response.json()) as { ok: boolean; code: 'connected' | 'failed' | 'missing' })
      } catch {
        setCaptureTestResult({ ok: false, code: 'failed' })
      }
    })
  }

  function clearDocumentCaptureKey() {
    startSave(async () => {
      try {
        const response = await fetch('/api/admin/ai/document-capture', { method: 'DELETE' })
        if (!response.ok) throw new Error('clear_failed')
        setDocumentCapture((current) => ({ ...current, enabled: false, hasKey: false }))
        setDocumentCaptureKey('')
        setCaptureTestResult(null)
        toast.success(t('documentCapture.keyRemoved'))
      } catch {
        toast.error(t('saveFailed'))
      }
    })
  }

  const keyPlaceholder = hasKey && savedProvider ? t('keySavedPlaceholder') : spec.keyHint || t('keyPlaceholder')

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

  function modelField(opts: { label: string; hint: string; value: string; setValue: (v: string) => void; placeholder: string }) {
    return (
      <div className="space-y-1.5">
        <Label>
          {opts.label} <span className="font-normal text-slate-400 dark:text-slate-500">({opts.hint})</span>
        </Label>
        {manual ? (
          <Input value={opts.value} onChange={(e) => opts.setValue(e.target.value)} autoComplete="off" spellCheck={false} placeholder={opts.placeholder} />
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
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500 dark:border-slate-600" />
        <span className="text-sm font-medium text-slate-800 dark:text-slate-100">{t('enabledLabel')}</span>
      </label>

      <section className="space-y-4 border-t border-slate-100 pt-5 dark:border-slate-800">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
              <Activity size={16} className="text-teal-600" />
              {t('agents.title')}
            </h3>
            <p className="mt-1 max-w-xl text-xs text-slate-500 dark:text-slate-400">{t('agents.description')}</p>
          </div>
          <Button variant="outline" size="sm" asChild>
            <Link href="/continuous-close">{t('agents.reviewWork')}</Link>
          </Button>
        </div>
        {!enabled ? <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">{t('agents.globallyDisabled')}</p> : null}
        <div className="grid gap-3 lg:grid-cols-2">
          {agents.map((agent) => {
            const activeDetectors = agent.detectors.filter((detector) => detector.enabled).length
            return (
              <div key={agent.agentKey} className="space-y-4 rounded-xl border border-slate-200 p-4 dark:border-slate-700">
                <div className="flex items-start justify-between gap-3">
                  <div>
                  <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t(`agents.${agent.agentKey}.title`)}</h4>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t(`agents.${agent.agentKey}.description`)}</p>
                </div>
                <label className="flex shrink-0 items-center gap-2 text-xs font-medium">
                    <input
                      type="checkbox"
                      checked={agent.enabled}
                      onChange={(event) =>
                        updateAgent(agent.agentKey, {
                          enabled: event.target.checked,
                        })
                      }
                      className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500 dark:border-slate-600"
                    />
                    {t('agents.enabled')}
                  </label>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge variant={activeDetectors === agent.detectors.length ? 'success' : 'warning'}>
                    {t('agents.controlsEnabled', {
                      count: activeDetectors,
                      total: agent.detectors.length,
                    })}
                  </Badge>
                  <Badge variant="outline">{agent.automaticRuns ? t(`agents.cadences.${agent.cadence}`) : t('agents.manualOnly')}</Badge>
                  <Badge variant="outline">
                    {t('agents.materialitySummary', {
                      amount: agent.materialityThreshold,
                    })}
                  </Badge>
                </div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">{t(`agents.${agent.agentKey}.coverage`)}</p>
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">
                    {agent.lastRunAt
                      ? t('agents.lastRun', {
                          date: new Intl.DateTimeFormat(locale, {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          }).format(new Date(agent.lastRunAt)),
                          status: t(`agents.runStatus.${agent.lastRunStatus ?? 'completed'}`),
                        })
                      : t('agents.neverRun')}
                    {agent.nextRunAt && enabled && agent.enabled && agent.automaticRuns ? (
                      <div className="mt-0.5">
                        {t('agents.nextRun', {
                          date: new Intl.DateTimeFormat(locale, {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          }).format(new Date(agent.nextRunAt)),
                        })}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button type="button" variant="outline" size="sm" asChild>
                      <Link href={`/admin/ai?agent=${agent.agentKey}`}>
                        <SlidersHorizontal size={13} />
                        {t('agents.configure')}
                        <ChevronRight size={13} />
                      </Link>
                    </Button>
                    <Button type="button" variant="outline" size="sm" disabled={!enabled || !agent.enabled || runningAgent !== null} onClick={() => void runAgent(agent.agentKey)}>
                      {runningAgent === agent.agentKey ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
                      {t('agents.runNow')}
                    </Button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </section>

      <section className="space-y-4 border-t border-slate-100 pt-5 dark:border-slate-800">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
              <FileScan size={16} className="text-teal-600" />
              {t('documentCapture.title')}
            </h3>
            <p className="mt-1 max-w-xl text-xs text-slate-500 dark:text-slate-400">{t('documentCapture.description')}</p>
          </div>
          <Button variant="outline" size="sm" asChild>
            <Link href="/ap/capture">{t('documentCapture.openQueue')}</Link>
          </Button>
        </div>
        <div className="space-y-4 rounded-xl border border-slate-200 p-4 dark:border-slate-700">
          <label className="flex items-center gap-2.5">
            <input
              type="checkbox"
              checked={documentCapture.enabled}
              onChange={(event) => setDocumentCapture({ ...documentCapture, enabled: event.target.checked })}
              className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500 dark:border-slate-600"
            />
            <span className="text-sm font-medium text-slate-800 dark:text-slate-100">{t('documentCapture.enabled')}</span>
          </label>
          {!enabled ? <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">{t('documentCapture.globallyDisabled')}</p> : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label>{t('documentCapture.endpoint')}</Label>
              <Input
                value={documentCapture.endpoint}
                onChange={(event) => {
                  setDocumentCapture({ ...documentCapture, endpoint: event.target.value })
                  setCaptureTestResult(null)
                }}
                placeholder="https://resource.cognitiveservices.azure.com"
                autoComplete="off"
                spellCheck={false}
              />
              <p className="text-xs text-slate-400 dark:text-slate-500">{t('documentCapture.endpointHint')}</p>
            </div>
            <div className="space-y-1.5">
              <Label>{t('documentCapture.key')}</Label>
              <Input
                type="password"
                value={documentCaptureKey}
                onChange={(event) => {
                  setDocumentCaptureKey(event.target.value)
                  setCaptureTestResult(null)
                }}
                placeholder={documentCapture.hasKey ? t('keySavedPlaceholder') : t('documentCapture.keyPlaceholder')}
                autoComplete="off"
              />
              {documentCapture.hasKey ? (
                <button type="button" onClick={clearDocumentCaptureKey} disabled={saving} className="text-xs font-medium text-red-600 hover:text-red-700 disabled:opacity-50 dark:text-red-400 dark:hover:text-red-300">
                  {t('documentCapture.removeKey')}
                </button>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label>{t('documentCapture.model')}</Label>
              <Input
                value={documentCapture.model}
                onChange={(event) => setDocumentCapture({ ...documentCapture, model: event.target.value })}
                placeholder="prebuilt-invoice"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t('documentCapture.confidence')}</Label>
              <Input
                inputMode="decimal"
                value={documentCapture.confidenceThreshold}
                onChange={(event) => setDocumentCapture({ ...documentCapture, confidenceThreshold: event.target.value })}
              />
              <p className="text-xs text-slate-400 dark:text-slate-500">{t('documentCapture.confidenceHint')}</p>
            </div>
            <label className="flex items-center gap-2 self-end pb-2 text-sm text-slate-700 dark:text-slate-300">
              <input
                type="checkbox"
                checked={documentCapture.autoCreatePoMatchedDrafts}
                onChange={(event) => setDocumentCapture({ ...documentCapture, autoCreatePoMatchedDrafts: event.target.checked })}
                className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500 dark:border-slate-600"
              />
              {t('documentCapture.autoDraft')}
            </label>
          </div>
          <div className="flex flex-wrap items-start gap-3">
            <Button type="button" variant="outline" disabled={testingCapture} onClick={testDocumentCapture}>
              {testingCapture ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
              {t('documentCapture.test')}
            </Button>
            {captureTestResult ? (
              <div className={cn('flex items-start gap-2 rounded-md border p-2.5 text-sm', captureTestResult.ok ? 'border-teal-200 bg-teal-50 text-teal-800 dark:border-teal-800/60 dark:bg-teal-950/50 dark:text-teal-200' : 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300')}>
                {captureTestResult.ok ? <CheckCircle2 size={15} className="mt-px shrink-0" /> : <XCircle size={15} className="mt-px shrink-0" />}
                <span>{t(`documentCapture.testResult.${captureTestResult.code}`)}</span>
              </div>
            ) : null}
          </div>
        </div>
      </section>

      <div className="space-y-1.5">
        <Label>{t('providerLabel')}</Label>
        <SearchSelect value={provider} onChange={onProviderChange} options={specs.map((s) => ({ value: s.value, label: s.label }))} sheetTitle={t('providerLabel')} ariaLabel={t('providerLabel')} />
      </div>

      {showBaseUrl ? (
        <div className="space-y-1.5">
          <Label>
            {t('baseUrlLabel')} <span className="font-normal text-slate-400 dark:text-slate-500">{spec.requiresBaseUrl ? t('baseUrlRequired') : t('baseUrlOptional')}</span>
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
          <p className="text-xs text-slate-400 dark:text-slate-500">{spec.baseUrl ? t('baseUrlDefault', { url: spec.baseUrl }) : t('baseUrlHint')}</p>
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
        <p className="text-xs text-slate-400 dark:text-slate-500">{hasKey && savedProvider ? t('keySavedHint') : t('keyHint')}</p>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>{t('modelsLabel')}</Label>
          <div className="flex items-center gap-3 text-xs">
            <button type="button" onClick={() => setManual((m) => !m)} className="text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-300">
              {manual ? t('models.pickFromList') : t('models.typeManually')}
            </button>
            <button type="button" onClick={() => requestModels(provider, apiKey, baseUrl)} disabled={loading} className="inline-flex items-center gap-1 font-medium text-teal-600 hover:text-teal-700 disabled:opacity-50">
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
          <p className="text-xs text-slate-400 dark:text-slate-500">{t('models.loaded', { count: models.length })}</p>
        ) : (
          <p className="text-xs text-slate-400 dark:text-slate-500">{spec.modelHint ?? t('models.hint')}</p>
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
            {testing ? <Loader2 size={14} className="mr-1.5 animate-spin" /> : <Zap size={14} className="mr-1.5" />}
            {t('testConnection')}
          </Button>
          {testResult ? (
            <div
              className={cn(
                'flex items-start gap-2 rounded-md border p-2.5 text-sm',
                testResult.ok ? 'border-teal-200 bg-teal-50 text-teal-800 dark:border-teal-800/60 dark:bg-teal-950/50 dark:text-teal-200' : 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300',
              )}
            >
              {testResult.ok ? <CheckCircle2 size={15} className="mt-px shrink-0" /> : <XCircle size={15} className="mt-px shrink-0" />}
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
      {selectedAgent ? (
        <AgentConfigurationDrawer
          key={selectedAgent.agentKey}
          agent={selectedAgent}
          specs={detectorSpecs.filter((detector) => detector.agentKey === selectedAgent.agentKey)}
          onSaved={(saved) => setAgents((current) => current.map((agent) => (agent.agentKey === saved.agentKey ? saved : agent)))}
        />
      ) : null}
    </div>
  )
}

function AgentConfigurationDrawer({ agent, specs, onSaved }: { agent: AgentPolicy; specs: DetectorSpecLite[]; onSaved: (agent: AgentPolicy) => void }) {
  const t = useTranslations('admin.ai')
  const router = useRouter()
  const [draft, setDraft] = useState<AgentPolicy>({
    ...agent,
    analysis: { ...agent.analysis },
    detectors: agent.detectors.map((detector) => ({
      ...detector,
      parameters: { ...detector.parameters },
    })),
  })
  const [saving, setSaving] = useState(false)

  function updateDetector(detectorKey: string, patch: Partial<DetectorPolicy>) {
    setDraft((current) => ({
      ...current,
      detectors: current.detectors.map((detector) => (detector.detectorKey === detectorKey ? { ...detector, ...patch } : detector)),
    }))
  }

  function resetRecommended() {
    setDraft((current) => ({
      ...current,
      analysis: {
        rootCauseAnalysis: true,
        recommendations: true,
        narrative: true,
        modelTier: 'smart',
        maxToolSteps: 16,
      },
      detectors: specs.map((spec) => ({
        detectorKey: spec.detectorKey,
        enabled: true,
        materialityThreshold: null,
        parameters: Object.fromEntries(spec.parameters.map((parameter) => [parameter.key, parameter.defaultValue])),
      })),
    }))
  }

  async function saveAgent() {
    setSaving(true)
    try {
      const response = await fetch(`/api/admin/ai/agents/${draft.agentKey}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(draft),
      })
      const body = (await response.json()) as AgentPolicy & { error?: string }
      if (!response.ok) throw new Error(body.error ?? 'save_failed')
      onSaved(body)
      toast.success(t('agents.configurationSaved'))
      router.push('/admin/ai')
      router.refresh()
    } catch {
      toast.error(t('agents.configurationSaveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <UrlDrawer
      open
      closeHref="/admin/ai"
      size="lg"
      title={t('agents.drawerTitle', {
        agent: t(`agents.${agent.agentKey}.title`),
      })}
      description={t('agents.drawerDescription')}
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <Button type="button" variant="ghost" onClick={resetRecommended} disabled={saving}>
            <RotateCcw size={14} />
            {t('agents.resetRecommended')}
          </Button>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" onClick={() => router.push('/admin/ai')} disabled={saving}>
              {t('agents.cancel')}
            </Button>
            <Button type="button" onClick={() => void saveAgent()} disabled={saving}>
              {saving ? <Loader2 size={14} className="animate-spin" /> : null}
              {t('agents.saveConfiguration')}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-6 p-1">
        <section className="space-y-4 rounded-xl border border-slate-200 bg-slate-50/70 p-4 dark:border-slate-800 dark:bg-slate-950/40">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('agents.operationTitle')}</h3>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t('agents.operationDescription')}</p>
            </div>
            <label className="flex shrink-0 items-center gap-2 text-xs font-medium text-slate-800 dark:text-slate-200">
              <input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500 dark:border-slate-600" />
              {t('agents.enabled')}
            </label>
          </div>
          <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300">
            <input
              type="checkbox"
              checked={draft.automaticRuns}
              disabled={!draft.enabled}
              onChange={(event) => setDraft({ ...draft, automaticRuns: event.target.checked })}
              className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500 disabled:opacity-50 dark:border-slate-600"
            />
            {t('agents.automaticRuns')}
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>{t('agents.cadence')}</Label>
              <Select
                value={draft.cadence}
                disabled={!draft.enabled || !draft.automaticRuns}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    cadence: event.target.value === 'weekly' ? 'weekly' : 'daily',
                  })
                }
              >
                <option value="daily">{t('agents.cadences.daily')}</option>
                <option value="weekly">{t('agents.cadences.weekly')}</option>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t('agents.materiality')}</Label>
              <Input
                inputMode="decimal"
                value={draft.materialityThreshold}
                disabled={!draft.enabled}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    materialityThreshold: event.target.value,
                  })
                }
              />
              <p className="text-[11px] text-slate-500 dark:text-slate-400">{t('agents.materialityHint')}</p>
            </div>
          </div>
        </section>

        <section className="space-y-4 rounded-xl border border-violet-200 bg-violet-50/60 p-4 dark:border-violet-900 dark:bg-violet-950/20">
          <div>
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('agents.reasoningTitle')}</h3>
            <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">{t('agents.reasoningDescription')}</p>
          </div>
          <div className="space-y-3">
            {(['rootCauseAnalysis', 'recommendations', 'narrative'] as const).map((capability) => (
              <label key={capability} className="flex items-start justify-between gap-4 rounded-lg border border-violet-100 bg-white/80 px-3 py-2.5 dark:border-violet-900/70 dark:bg-slate-900/80">
                <span>
                  <span className="block text-xs font-medium text-slate-800 dark:text-slate-200">{t(`agents.reasoning.${capability}.title`)}</span>
                  <span className="mt-0.5 block text-[11px] leading-4 text-slate-500 dark:text-slate-400">{t(`agents.reasoning.${capability}.description`)}</span>
                </span>
                <input
                  type="checkbox"
                  checked={draft.analysis[capability]}
                  disabled={!draft.enabled}
                  onChange={(event) => setDraft({
                    ...draft,
                    analysis: { ...draft.analysis, [capability]: event.target.checked },
                  })}
                  className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-teal-600 focus:ring-teal-500 disabled:opacity-50 dark:border-slate-600"
                />
              </label>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>{t('agents.modelTier')}</Label>
              <Select
                value={draft.analysis.modelTier}
                disabled={!draft.enabled}
                onChange={(event) => setDraft({
                  ...draft,
                  analysis: { ...draft.analysis, modelTier: event.target.value === 'fast' ? 'fast' : 'smart' },
                })}
              >
                <option value="smart">{t('agents.modelTiers.smart')}</option>
                <option value="fast">{t('agents.modelTiers.fast')}</option>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t('agents.maxToolSteps')}</Label>
              <Input
                type="number"
                min={4}
                max={30}
                step={1}
                value={draft.analysis.maxToolSteps}
                disabled={!draft.enabled}
                onChange={(event) => setDraft({
                  ...draft,
                  analysis: { ...draft.analysis, maxToolSteps: Number(event.target.value) },
                })}
              />
              <p className="text-[11px] text-slate-500 dark:text-slate-400">{t('agents.maxToolStepsHint')}</p>
            </div>
          </div>
        </section>

        <section className="space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('agents.detectorControlsTitle')}</h3>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t('agents.detectorControlsDescription')}</p>
          </div>
          {specs.map((spec) => {
            const detector = draft.detectors.find((item) => item.detectorKey === spec.detectorKey)
            if (!detector) return null
            const customMateriality = detector.materialityThreshold !== null
            return (
              <div
                key={spec.detectorKey}
                className={cn(
                  'space-y-4 rounded-xl border p-4 transition-colors',
                  detector.enabled ? 'border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900' : 'border-slate-200 bg-slate-50 opacity-75 dark:border-slate-800 dark:bg-slate-950/50',
                )}
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h4 className="text-sm font-medium text-slate-900 dark:text-slate-100">{t(`agents.detectors.${spec.detectorKey}.title`)}</h4>
                    <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">{t(`agents.detectors.${spec.detectorKey}.description`)}</p>
                  </div>
                  <label className="flex shrink-0 items-center gap-2 text-xs font-medium text-slate-700 dark:text-slate-300">
                    <input
                      type="checkbox"
                      checked={detector.enabled}
                      onChange={(event) =>
                        updateDetector(detector.detectorKey, {
                          enabled: event.target.checked,
                        })
                      }
                      className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500 dark:border-slate-600"
                    />
                    {t(detector.enabled ? 'agents.controlOn' : 'agents.controlOff')}
                  </label>
                </div>
                {spec.supportsMateriality ? (
                  <div className="space-y-2 border-t border-slate-100 pt-3 dark:border-slate-800">
                    <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300">
                      <input
                        type="checkbox"
                        checked={customMateriality}
                        disabled={!detector.enabled}
                        onChange={(event) =>
                          updateDetector(detector.detectorKey, {
                            materialityThreshold: event.target.checked ? draft.materialityThreshold : null,
                          })
                        }
                        className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500 disabled:opacity-50 dark:border-slate-600"
                      />
                      {t('agents.customMateriality')}
                    </label>
                    {customMateriality ? (
                      <div className="max-w-xs space-y-1.5">
                        <Label>{t('agents.detectorMateriality')}</Label>
                        <Input
                          inputMode="decimal"
                          value={detector.materialityThreshold ?? ''}
                          disabled={!detector.enabled}
                          onChange={(event) =>
                            updateDetector(detector.detectorKey, {
                              materialityThreshold: event.target.value,
                            })
                          }
                        />
                      </div>
                    ) : (
                      <p className="text-[11px] text-slate-500 dark:text-slate-400">
                        {t('agents.inheritedMateriality', {
                          amount: draft.materialityThreshold,
                        })}
                      </p>
                    )}
                  </div>
                ) : null}
                {spec.parameters.length ? (
                  <div className="grid gap-3 border-t border-slate-100 pt-3 sm:grid-cols-2 dark:border-slate-800">
                    {spec.parameters.map((parameter) => (
                      <div key={parameter.key} className="space-y-1.5">
                        <Label>
                          {t('agents.parameterLabel', {
                            label: t(`agents.parameters.${parameter.key}`),
                            unit: t(`agents.units.${parameter.unit}`),
                          })}
                        </Label>
                        <Input
                          type="number"
                          min={parameter.min}
                          max={parameter.max}
                          step={parameter.step}
                          value={detector.parameters[parameter.key] ?? parameter.defaultValue}
                          disabled={!detector.enabled}
                          onChange={(event) =>
                            updateDetector(detector.detectorKey, {
                              parameters: {
                                ...detector.parameters,
                                [parameter.key]: Number(event.target.value),
                              },
                            })
                          }
                        />
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            )
          })}
          <p className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-300">{t('agents.disabledFindingBehavior')}</p>
        </section>
      </div>
    </UrlDrawer>
  )
}

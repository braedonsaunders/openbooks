'use client'

import { useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { ArrowLeft } from 'lucide-react'
import { toast } from 'sonner'
import { Badge, Button, Input, Label, cn } from '@openbooks/ui'

/** Serializable slices the loader hands over (JSON-safe engine policy JSON). */
export type AgentPolicyDetectorDraft = {
  detectorKey: string
  enabled: boolean
  materialityThreshold: string | null
  parameters: Record<string, number>
}

export type AgentPolicyDraft = {
  enabled: boolean
  automaticRuns: boolean
  cadence: 'daily' | 'weekly'
  materialityThreshold: string
  detectors: AgentPolicyDetectorDraft[]
  analysis: {
    rootCauseAnalysis: boolean
    recommendations: boolean
    narrative: boolean
    modelTier: 'fast' | 'smart'
    maxToolSteps: number
  }
}

export type AgentPolicyNotificationDraft = {
  mode: 'findings_only' | 'digest' | 'immediate'
  roleIds: string[]
  userIds: string[]
} | null

export type AgentPolicySpecView = {
  detectorKey: string
  supportsMateriality: boolean
  parameters: { key: string; defaultValue: number; min: number; max: number; step: number; unit: string }[]
}

const NOTIFICATION_MODES = ['findings_only', 'digest', 'immediate'] as const

/**
 * One pack's policy — schedule, detector controls, analysis tier and finding
 * routing. One draft, one PUT of the FULL draft (a partial save would reset
 * untouched controls to defaults — the overview toggle precedent), toast +
 * `router.refresh()` on completion. Detector/parameter/analysis wording
 * reuses the `ai.agents.*` keys the provider drawer reads.
 */
export function AgentPolicyWorkspace({
  pack,
  specs,
  notification,
  roles,
  users,
  usersTruncated,
  featureEnabled,
}: {
  pack: {
    agentKey: string
    policy: AgentPolicyDraft
    lastRun: {
      startedAt: string
      status: 'completed' | 'failed' | 'skipped' | 'running'
    } | null
    openFindings: number
  }
  specs: AgentPolicySpecView[]
  notification: AgentPolicyNotificationDraft
  roles: { id: string; name: string }[]
  users: { id: string; name: string; email: string }[]
  usersTruncated: boolean
  featureEnabled: boolean
}) {
  const t = useTranslations('admin')
  const router = useRouter()
  const initial = useRef({ policy: pack.policy, specs, notification })
  const [draft, setDraft] = useState<AgentPolicyDraft>(() => structuredDraft(pack.policy, specs))
  const [routing, setRouting] = useState<AgentPolicyNotificationDraft>(() => notification)
  const [saving, setSaving] = useState(false)

  function cancel() {
    setDraft(structuredDraft(initial.current.policy, initial.current.specs))
    setRouting(initial.current.notification)
  }

  const patch = (next: Partial<AgentPolicyDraft>) => setDraft((current) => ({ ...current, ...next }))

  function updateDetector(detectorKey: string, next: Partial<AgentPolicyDetectorDraft>) {
    setDraft((current) => ({
      ...current,
      detectors: current.detectors.map((detector) =>
        detector.detectorKey === detectorKey ? { ...detector, ...next } : detector,
      ),
    }))
  }

  function updateParam(detectorKey: string, paramKey: string, value: number) {
    setDraft((current) => ({
      ...current,
      detectors: current.detectors.map((detector) =>
        detector.detectorKey === detectorKey
          ? { ...detector, parameters: { ...detector.parameters, [paramKey]: value } }
          : detector,
      ),
    }))
  }

  function toggleId(list: string[], id: string) {
    return list.includes(id) ? list.filter((entry) => entry !== id) : [...list, id]
  }

  function updateRouting(next: Partial<Exclude<AgentPolicyNotificationDraft, null>>) {
    setRouting((current) => ({ mode: 'findings_only', roleIds: [], userIds: [], ...current, ...next }))
  }

  async function save() {
    if (saving) return
    setSaving(true)
    try {
      const res = await fetch(`/api/admin/setup/agents/${pack.agentKey}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...draft, notification: routing }),
      })
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(payload.error ?? t('ai.agents.configurationSaveFailed'))
      }
      toast.success(t('ai.agents.configurationSaved'))
      router.refresh()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  function resetDefaults() {
    setDraft((current) => ({
      ...current,
      detectors: specs.map((spec) => ({
        detectorKey: spec.detectorKey,
        enabled: true,
        materialityThreshold: null,
        parameters: Object.fromEntries(spec.parameters.map((parameter) => [parameter.key, parameter.defaultValue])),
      })),
    }))
  }

  const activeDetectors = draft.detectors.filter((detector) => detector.enabled).length

  return (
    <div className="space-y-8">
      <div>
        <Link
          href="/admin/setup/agents"
          className="flex w-fit items-center gap-1.5 text-xs font-medium text-teal-700 underline dark:text-teal-300"
        >
          <ArrowLeft size={13} /> {t('setup.agents.policy.backLabel')}
        </Link>
        <div className="mt-2 flex items-center gap-2">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            {t(`setup.agents.packs.${pack.agentKey}.title`)}
          </h2>
          <Badge variant={draft.enabled ? 'success' : 'secondary'}>
            {t(`setup.agents.overview.${draft.enabled ? 'enabled' : 'disabled'}`)}
          </Badge>
        </div>
        <p className="mt-1 max-w-2xl text-sm text-slate-500 dark:text-slate-400">
          {t(`setup.agents.packs.${pack.agentKey}.description`)}
        </p>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          {pack.lastRun
            ? t('setup.agents.overview.lastRun', {
                date: new Date(pack.lastRun.startedAt).toLocaleString(),
                status: t(`setup.agents.overview.runStatus.${pack.lastRun.status}`),
              })
            : t('setup.agents.overview.neverRun')}
          {' · '}
          {t('setup.agents.overview.openFindings', { count: pack.openFindings })}
        </p>
      </div>

      {!featureEnabled ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
          {t('setup.agents.overview.featureOff')}{' '}
          <Link href="/admin/setup/features" className="font-medium underline">
            {t('setup.agents.overview.enableModule')}
          </Link>
        </p>
      ) : null}

      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('ai.agents.operationTitle')}</h3>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t('ai.agents.operationDescription')}</p>
        </div>
        <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <label className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-300">
            <input
              type="checkbox"
              checked={draft.enabled}
              disabled={!featureEnabled}
              onChange={(event) => patch({ enabled: event.target.checked })}
              className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500 disabled:opacity-50 dark:border-slate-600"
            />
            {t('ai.agents.enabled')}
          </label>
          <label className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-300">
            <input
              type="checkbox"
              checked={draft.automaticRuns}
              disabled={!draft.enabled}
              onChange={(event) => patch({ automaticRuns: event.target.checked })}
              className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500 disabled:opacity-50 dark:border-slate-600"
            />
            {t('ai.agents.automaticRuns')}
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>{t('ai.agents.cadence')}</Label>
              <select
                value={draft.cadence}
                disabled={!draft.enabled || !draft.automaticRuns}
                onChange={(event) => patch({ cadence: event.target.value === 'weekly' ? 'weekly' : 'daily' })}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 disabled:opacity-50 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
              >
                <option value="daily">{t('ai.agents.cadences.daily')}</option>
                <option value="weekly">{t('ai.agents.cadences.weekly')}</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label>{t('ai.agents.materiality')}</Label>
              <Input
                inputMode="decimal"
                value={draft.materialityThreshold}
                disabled={!draft.enabled}
                onChange={(event) => patch({ materialityThreshold: event.target.value })}
              />
              <p className="text-[11px] text-slate-500 dark:text-slate-400">{t('ai.agents.materialityHint')}</p>
            </div>
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('ai.agents.detectorControlsTitle')}</h3>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t('ai.agents.detectorControlsDescription')}</p>
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
                detector.enabled
                  ? 'border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900'
                  : 'border-slate-200 bg-slate-50 opacity-75 dark:border-slate-800 dark:bg-slate-950/50',
              )}
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h4 className="text-sm font-medium text-slate-900 dark:text-slate-100">
                    {t(`ai.agents.detectors.${spec.detectorKey}.title`)}
                  </h4>
                  <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
                    {t(`ai.agents.detectors.${spec.detectorKey}.description`)}
                  </p>
                </div>
                <label className="flex shrink-0 items-center gap-2 text-xs font-medium text-slate-700 dark:text-slate-300">
                  <input
                    type="checkbox"
                    checked={detector.enabled}
                    onChange={(event) => updateDetector(detector.detectorKey, { enabled: event.target.checked })}
                    className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500 dark:border-slate-600"
                  />
                  {t(detector.enabled ? 'ai.agents.controlOn' : 'ai.agents.controlOff')}
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
                    {t('ai.agents.customMateriality')}
                  </label>
                  {customMateriality ? (
                    <div className="max-w-xs space-y-1.5">
                      <Label>{t('ai.agents.detectorMateriality')}</Label>
                      <Input
                        inputMode="decimal"
                        value={detector.materialityThreshold ?? ''}
                        disabled={!detector.enabled}
                        onChange={(event) =>
                          updateDetector(detector.detectorKey, { materialityThreshold: event.target.value })
                        }
                      />
                    </div>
                  ) : (
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">
                      {t('ai.agents.inheritedMateriality', { amount: draft.materialityThreshold })}
                    </p>
                  )}
                </div>
              ) : null}
              {spec.parameters.length ? (
                <div className="grid gap-3 border-t border-slate-100 pt-3 sm:grid-cols-2 dark:border-slate-800">
                  {spec.parameters.map((parameter) => (
                    <div key={parameter.key} className="space-y-1.5">
                      <Label>
                        {t('ai.agents.parameterLabel', {
                          label: t(`ai.agents.parameters.${parameter.key}`),
                          unit: t(`ai.agents.units.${parameter.unit}`),
                        })}
                      </Label>
                      <Input
                        type="number"
                        min={parameter.min}
                        max={parameter.max}
                        step={parameter.step}
                        value={detector.parameters[parameter.key] ?? parameter.defaultValue}
                        disabled={!detector.enabled}
                        onChange={(event) => {
                          const value = Number(event.target.value)
                          if (Number.isFinite(value)) updateParam(detector.detectorKey, parameter.key, value)
                        }}
                      />
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          )
        })}
        <Button type="button" variant="outline" size="sm" onClick={resetDefaults}>
          {t('ai.agents.resetRecommended')}
        </Button>
        <p className="text-[11px] text-slate-500 dark:text-slate-400">{t('ai.agents.disabledFindingBehavior')}</p>
      </section>

      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('ai.agents.reasoningTitle')}</h3>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t('ai.agents.reasoningDescription')}</p>
        </div>
        <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          {(
            [
              ['rootCauseAnalysis', 'ai.agents.reasoning.rootCauseAnalysis'],
              ['recommendations', 'ai.agents.reasoning.recommendations'],
              ['narrative', 'ai.agents.reasoning.narrative'],
            ] as const
          ).map(([key, copyKey]) => (
            <label key={key} className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-300">
              <input
                type="checkbox"
                checked={draft.analysis[key]}
                onChange={(event) =>
                  patch({ analysis: { ...draft.analysis, [key]: event.target.checked } })
                }
                className="mt-0.5 h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500 dark:border-slate-600"
              />
              <span>
                <span className="font-medium">{t(`${copyKey}.title`)}</span>
                <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">{t(`${copyKey}.description`)}</span>
              </span>
            </label>
          ))}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>{t('ai.agents.modelTier')}</Label>
              <select
                value={draft.analysis.modelTier}
                onChange={(event) =>
                  patch({
                    analysis: {
                      ...draft.analysis,
                      modelTier: event.target.value === 'fast' ? 'fast' : 'smart',
                    },
                  })
                }
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
              >
                <option value="smart">{t('ai.agents.modelTiers.smart')}</option>
                <option value="fast">{t('ai.agents.modelTiers.fast')}</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label>{t('ai.agents.maxToolSteps')}</Label>
              <Input
                type="number"
                min={4}
                max={30}
                step={1}
                value={draft.analysis.maxToolSteps}
                onChange={(event) => {
                  const value = Number(event.target.value)
                  if (Number.isInteger(value)) patch({ analysis: { ...draft.analysis, maxToolSteps: value } })
                }}
              />
              <p className="text-[11px] text-slate-500 dark:text-slate-400">{t('ai.agents.maxToolStepsHint')}</p>
            </div>
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {t('setup.agents.policy.notificationsTitle')}
          </h3>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {t('setup.agents.policy.notificationsDescription')}
          </p>
        </div>
        <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <div className="space-y-2">
            {NOTIFICATION_MODES.map((mode) => (
              <label key={mode} className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-300">
                <input
                  type="radio"
                  name={`notify-${pack.agentKey}`}
                  checked={(routing?.mode ?? 'findings_only') === mode}
                  onChange={() => updateRouting({ mode })}
                  className="mt-0.5 h-4 w-4 border-slate-300 text-teal-600 focus:ring-teal-500 dark:border-slate-600"
                />
                <span>
                  <span className="font-medium">{t(`setup.agents.policy.modes.${mode}.title`)}</span>
                  <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">
                    {t(`setup.agents.policy.modes.${mode}.description`)}
                  </span>
                </span>
              </label>
            ))}
          </div>
          {(routing?.mode ?? 'findings_only') !== 'findings_only' ? (
            <div className="grid gap-3 border-t border-slate-100 pt-3 sm:grid-cols-2 dark:border-slate-800">
              <div className="space-y-1.5">
                <Label>{t('setup.agents.policy.rolesLabel')}</Label>
                <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-slate-100 p-2 dark:border-slate-800">
                  {roles.map((role) => (
                    <label key={role.id} className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300">
                      <input
                        type="checkbox"
                        checked={routing?.roleIds.includes(role.id) ?? false}
                        onChange={() => updateRouting({ roleIds: toggleId(routing?.roleIds ?? [], role.id) })}
                        className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500 dark:border-slate-600"
                      />
                      {role.name}
                    </label>
                  ))}
                  {roles.length === 0 ? (
                    <p className="text-[11px] text-slate-400">{t('setup.agents.policy.noTargets')}</p>
                  ) : null}
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>{t('setup.agents.policy.usersLabel')}</Label>
                <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-slate-100 p-2 dark:border-slate-800">
                  {users.map((user) => (
                    <label key={user.id} className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300">
                      <input
                        type="checkbox"
                        checked={routing?.userIds.includes(user.id) ?? false}
                        onChange={() => updateRouting({ userIds: toggleId(routing?.userIds ?? [], user.id) })}
                        className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500 dark:border-slate-600"
                      />
                      <span className="truncate">
                        {user.name} <span className="text-slate-400">· {user.email}</span>
                      </span>
                    </label>
                  ))}
                  {users.length === 0 ? (
                    <p className="text-[11px] text-slate-400">{t('setup.agents.policy.noTargets')}</p>
                  ) : null}
                </div>
                {usersTruncated ? (
                  <p className="text-[11px] text-slate-400">{t('setup.agents.policy.usersTruncatedNote')}</p>
                ) : null}
              </div>
            </div>
          ) : null}
          <p className="text-[11px] text-slate-500 dark:text-slate-400">{t('setup.agents.policy.deliveryNote')}</p>
        </div>
      </section>

      <div className="flex items-center gap-3">
        <span className="text-xs tabular-nums text-slate-400 dark:text-slate-500">
          {t('setup.agents.overview.controlsEnabled', {
            count: activeDetectors,
            total: draft.detectors.length,
          })}
        </span>
        <span className="flex-1" />
        <Button type="button" variant="outline" onClick={cancel}>
          {t('ai.agents.cancel')}
        </Button>
        <Button type="button" disabled={saving || !featureEnabled} onClick={() => void save()}>
          {t('ai.agents.saveConfiguration')}
        </Button>
      </div>
    </div>
  )
}

/** Draft from the stored policy, backfilled against the current spec registry. */
function structuredDraft(policy: AgentPolicyDraft, specs: AgentPolicySpecView[]): AgentPolicyDraft {
  const byKey = new Map(policy.detectors.map((detector) => [detector.detectorKey, detector]))
  return {
    ...policy,
    detectors: specs.map((spec) => ({
      detectorKey: spec.detectorKey,
      enabled: byKey.get(spec.detectorKey)?.enabled ?? true,
      materialityThreshold: byKey.get(spec.detectorKey)?.materialityThreshold ?? null,
      parameters: Object.fromEntries(
        spec.parameters.map((parameter) => [
          parameter.key,
          byKey.get(spec.detectorKey)?.parameters[parameter.key] ?? parameter.defaultValue,
        ]),
      ),
    })),
  }
}

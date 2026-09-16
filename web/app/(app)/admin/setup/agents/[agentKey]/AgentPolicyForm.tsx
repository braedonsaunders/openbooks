'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Bell, ListChecks, Settings2, Sparkles, X } from 'lucide-react'
import { toast } from 'sonner'
import { Badge, Button, Card, CardContent, Input, Label, SearchSelect, cn } from '@openbooks/ui'

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

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  // Descriptive hints live in the label's `?` popover (FieldLabel); inline
  // text under a control is reserved for validation/state messages.
  return (
    <div className="space-y-1.5">
      <Label help={hint}>{label}</Label>
      {children}
    </div>
  )
}

function Check({
  checked,
  disabled,
  onChange,
  children,
}: {
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
  children: React.ReactNode
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-slate-700 disabled:opacity-50 dark:text-slate-200">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      {children}
    </label>
  )
}

function Section({
  icon,
  title,
  description,
  children,
}: {
  icon: React.ReactNode
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-teal-50 p-2 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300">{icon}</div>
          <div>
            <h3 className="font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
            <p className="mt-0.5 max-w-3xl text-sm text-slate-500 dark:text-slate-400">{description}</p>
          </div>
        </div>
      </div>
      {children}
    </section>
  )
}

type TokenOption = { value: string; label: string; hint?: string }

/** Searchable add-and-remove token list backed by a large option set (people,
 *  roles). Selected values render as removable chips. */
function TokenSelect({
  options,
  value,
  onChange,
  placeholder,
  empty,
  ariaLabel,
}: {
  options: TokenOption[]
  value: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  empty?: string
  ariaLabel?: string
}) {
  const byValue = new Map(options.map((option) => [option.value, option]))
  const available = options.filter((option) => !value.includes(option.value))
  return (
    <div className="space-y-2">
      <SearchSelect
        value=""
        onChange={(next) => {
          if (next && !value.includes(next)) onChange([...value, next])
        }}
        options={available}
        placeholder={placeholder}
        searchable
        emptyLabel={empty}
        ariaLabel={ariaLabel ?? placeholder}
      />
      {value.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {value.map((item) => (
            <span
              key={item}
              className="flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
            >
              {byValue.get(item)?.label ?? item}
              <button
                type="button"
                onClick={() => onChange(value.filter((entry) => entry !== item))}
                className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-100"
                aria-label={byValue.get(item)?.label ?? item}
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/**
 * One pack's policy — schedule, detector controls, analysis tier and finding
 * routing. The Setup form pattern (the close-setup precedent): sections in
 * shared Card shells, fields from the shared @openbooks/ui components
 * (SearchSelect for single selects, TokenSelect add-and-remove lists for the
 * role/people routing), one draft, one PUT of the FULL draft (a partial save
 * would reset untouched controls to defaults — the overview toggle
 * precedent), toast + `router.refresh()` on completion. Detector/parameter/
 * analysis wording reuses the `ai.agents.*` keys the provider drawer reads.
 */
export function AgentPolicyForm({
  statusLabel,
  statusEnabled,
  description,
  runLine,
  pack,
  specs,
  notification,
  roles,
  users,
  usersTruncated,
  featureEnabled,
}: {
  statusLabel: string
  statusEnabled: boolean
  description: string
  runLine: string
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
  const routingMode = routing?.mode ?? 'findings_only'

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={statusEnabled ? 'success' : 'secondary'}>{statusLabel}</Badge>
        <p className="w-full text-sm text-slate-500 dark:text-slate-400">{description}</p>
        <p className="w-full text-xs text-slate-500 dark:text-slate-400">{runLine}</p>
      </div>

      <Section icon={<Settings2 size={17} />} title={t('ai.agents.operationTitle')} description={t('ai.agents.operationDescription')}>
        <Card>
          <CardContent className="space-y-4 p-4">
            <Check checked={draft.enabled} disabled={!featureEnabled} onChange={(checked) => patch({ enabled: checked })}>
              {t('ai.agents.enabled')}
            </Check>
            <Check
              checked={draft.automaticRuns}
              disabled={!draft.enabled}
              onChange={(checked) => patch({ automaticRuns: checked })}
            >
              {t('ai.agents.automaticRuns')}
            </Check>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('ai.agents.cadence')}>
                <SearchSelect
                  value={draft.cadence}
                  onChange={(value) => patch({ cadence: value === 'weekly' ? 'weekly' : 'daily' })}
                  options={[
                    { value: 'daily', label: t('ai.agents.cadences.daily') },
                    { value: 'weekly', label: t('ai.agents.cadences.weekly') },
                  ]}
                  disabled={!draft.enabled || !draft.automaticRuns}
                  ariaLabel={t('ai.agents.cadence')}
                />
              </Field>
              <Field label={t('ai.agents.materiality')} hint={t('ai.agents.materialityHint')}>
                <Input
                  inputMode="decimal"
                  value={draft.materialityThreshold}
                  disabled={!draft.enabled}
                  onChange={(event) => patch({ materialityThreshold: event.target.value })}
                />
              </Field>
            </div>
          </CardContent>
        </Card>
      </Section>

      <Section
        icon={<ListChecks size={17} />}
        title={t('ai.agents.detectorControlsTitle')}
        description={t('ai.agents.detectorControlsDescription')}
      >
        {specs.map((spec) => {
          const detector = draft.detectors.find((item) => item.detectorKey === spec.detectorKey)
          if (!detector) return null
          const customMateriality = detector.materialityThreshold !== null
          return (
            <Card
              key={spec.detectorKey}
              className={cn(!detector.enabled && 'opacity-75')}
            >
              <CardContent className="space-y-4 p-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h4 className="text-sm font-medium text-slate-900 dark:text-slate-100">
                      {t(`ai.agents.detectors.${spec.detectorKey}.title`)}
                    </h4>
                    <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
                      {t(`ai.agents.detectors.${spec.detectorKey}.description`)}
                    </p>
                  </div>
                  <Check checked={detector.enabled} onChange={(checked) => updateDetector(detector.detectorKey, { enabled: checked })}>
                    {t(detector.enabled ? 'ai.agents.controlOn' : 'ai.agents.controlOff')}
                  </Check>
                </div>
                {spec.supportsMateriality ? (
                  <div className="space-y-2 border-t border-slate-100 pt-3 dark:border-slate-800">
                    <Check
                      checked={customMateriality}
                      disabled={!detector.enabled}
                      onChange={(checked) =>
                        updateDetector(detector.detectorKey, {
                          materialityThreshold: checked ? draft.materialityThreshold : null,
                        })
                      }
                    >
                      {t('ai.agents.customMateriality')}
                    </Check>
                    {customMateriality ? (
                      <div className="max-w-xs">
                        <Field label={t('ai.agents.detectorMateriality')}>
                          <Input
                            inputMode="decimal"
                            value={detector.materialityThreshold ?? ''}
                            disabled={!detector.enabled}
                            onChange={(event) =>
                              updateDetector(detector.detectorKey, { materialityThreshold: event.target.value })
                            }
                          />
                        </Field>
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
                      <Field
                        key={parameter.key}
                        label={t('ai.agents.parameterLabel', {
                          label: t(`ai.agents.parameters.${parameter.key}`),
                          unit: t(`ai.agents.units.${parameter.unit}`),
                        })}
                      >
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
                      </Field>
                    ))}
                  </div>
                ) : null}
              </CardContent>
            </Card>
          )
        })}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="outline" size="sm" onClick={resetDefaults}>
            {t('ai.agents.resetRecommended')}
          </Button>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">{t('ai.agents.disabledFindingBehavior')}</p>
        </div>
      </Section>

      <Section icon={<Sparkles size={17} />} title={t('ai.agents.reasoningTitle')} description={t('ai.agents.reasoningDescription')}>
        <Card>
          <CardContent className="space-y-4 p-4">
            {(
              [
                ['rootCauseAnalysis', 'ai.agents.reasoning.rootCauseAnalysis'],
                ['recommendations', 'ai.agents.reasoning.recommendations'],
                ['narrative', 'ai.agents.reasoning.narrative'],
              ] as const
            ).map(([key, copyKey]) => (
              <Check
                key={key}
                checked={draft.analysis[key]}
                onChange={(checked) => patch({ analysis: { ...draft.analysis, [key]: checked } })}
              >
                <span>
                  <span className="font-medium">{t(`${copyKey}.title`)}</span>
                  <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">
                    {t(`${copyKey}.description`)}
                  </span>
                </span>
              </Check>
            ))}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('ai.agents.modelTier')}>
                <SearchSelect
                  value={draft.analysis.modelTier}
                  onChange={(value) =>
                    patch({
                      analysis: { ...draft.analysis, modelTier: value === 'fast' ? 'fast' : 'smart' },
                    })
                  }
                  options={[
                    { value: 'smart', label: t('ai.agents.modelTiers.smart') },
                    { value: 'fast', label: t('ai.agents.modelTiers.fast') },
                  ]}
                  ariaLabel={t('ai.agents.modelTier')}
                />
              </Field>
              <Field label={t('ai.agents.maxToolSteps')} hint={t('ai.agents.maxToolStepsHint')}>
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
              </Field>
            </div>
          </CardContent>
        </Card>
      </Section>

      <Section
        icon={<Bell size={17} />}
        title={t('setup.agents.policy.notificationsTitle')}
        description={t('setup.agents.policy.notificationsDescription')}
      >
        <Card>
          <CardContent className="space-y-4 p-4">
            <div className="space-y-2">
              {NOTIFICATION_MODES.map((mode) => (
                <label key={mode} className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-300">
                  <input
                    type="radio"
                    name={`notify-${pack.agentKey}`}
                    checked={routingMode === mode}
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
            {routingMode !== 'findings_only' ? (
              <div className="grid gap-3 border-t border-slate-100 pt-3 sm:grid-cols-2 dark:border-slate-800">
                <Field label={t('setup.agents.policy.rolesLabel')}>
                  <TokenSelect
                    options={roles.map((role) => ({ value: role.id, label: role.name }))}
                    value={routing?.roleIds ?? []}
                    onChange={(roleIds) => updateRouting({ roleIds })}
                    placeholder={t('setup.agents.policy.rolesPlaceholder')}
                    empty={t('setup.agents.policy.noTargets')}
                    ariaLabel={t('setup.agents.policy.rolesLabel')}
                  />
                </Field>
                <div className="space-y-1.5">
                  <Field label={t('setup.agents.policy.usersLabel')}>
                    <TokenSelect
                      options={users.map((user) => ({ value: user.id, label: user.name, hint: user.email }))}
                      value={routing?.userIds ?? []}
                      onChange={(userIds) => updateRouting({ userIds })}
                      placeholder={t('setup.agents.policy.usersPlaceholder')}
                      empty={t('setup.agents.policy.noTargets')}
                      ariaLabel={t('setup.agents.policy.usersLabel')}
                    />
                  </Field>
                  {usersTruncated ? (
                    <p className="text-[11px] text-slate-400">{t('setup.agents.policy.usersTruncatedNote')}</p>
                  ) : null}
                </div>
              </div>
            ) : null}
            <p className="text-[11px] text-slate-500 dark:text-slate-400">{t('setup.agents.policy.deliveryNote')}</p>
          </CardContent>
        </Card>
      </Section>

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

'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import {
  ArrowLeftRight,
  BookOpen,
  CircleDollarSign,
  ClipboardCheck,
  History,
  Landmark,
  Loader2,
  Play,
  Puzzle,
  Receipt,
  TrendingUp,
  type LucideIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge, Button, cn } from '@openbooks/ui'

/** Serializable slice of one pack's policy — the JSON the loader hands over. */
export type AgentOverviewPolicy = {
  agentKey: string
  enabled: boolean
  automaticRuns: boolean
  cadence: 'daily' | 'weekly'
  materialityThreshold: string
  detectors: { detectorKey: string; enabled: boolean }[]
  analysis: Record<string, unknown>
  lastRunAt: string | null
  nextRunAt: string | null
  lastRunStatus: 'completed' | 'failed' | 'skipped' | 'running' | null
}

export type AgentOverviewLastRun = {
  id: string
  status: 'completed' | 'failed' | 'skipped' | 'running'
  startedAt: string
  finishedAt: string | null
  detected: number
  autoResolved: number
}

export type AgentOverviewRowView = {
  agentKey: string
  policy: AgentOverviewPolicy
  lastRun: AgentOverviewLastRun | null
  openFindings: number
}

/** Icon per pack — falls back to a neutral square when unmapped. */
const ICONS: Record<string, LucideIcon> = {
  accounting: Landmark,
  finance: TrendingUp,
  collections: CircleDollarSign,
  payables: Receipt,
  reconciliation: ArrowLeftRight,
  hygiene: ClipboardCheck,
}

/**
 * The Agents overview — one card per pack (icon · name · description ·
 * status · cadence · last run · open findings · switch · run-now ·
 * configure link). Saves on toggle with the FULL policy round-tripped, so a
 * quick enable/disable never resets detector controls to defaults; nav
 * re-renders so gated surfaces appear/disappear. Switches fence on the
 * Continuous Close module switch exactly like Features fences on its
 * dependencies — the server refuses the enable too (409).
 */
export function AgentsOverviewWorkspace({
  rows,
  featureEnabled,
}: {
  rows: AgentOverviewRowView[]
  featureEnabled: boolean
}) {
  const t = useTranslations('admin')
  const router = useRouter()
  const [policies, setPolicies] = useState<Record<string, AgentOverviewPolicy>>(() =>
    Object.fromEntries(rows.map((row) => [row.agentKey, row.policy])),
  )
  const [pending, setPending] = useState<string | null>(null)
  const [running, setRunning] = useState<string | null>(null)

  async function toggle(agentKey: string) {
    if (pending || running) return
    const policy = policies[agentKey]
    if (!policy) return
    const next = !policy.enabled
    // The fence mirrors the server: enabling while the module is off is
    // refused with a link to the switch that unblocks it.
    if (next && !featureEnabled) return
    setPolicies((current) => ({ ...current, [agentKey]: { ...policy, enabled: next } }))
    setPending(agentKey)
    try {
      const res = await fetch(`/api/admin/setup/agents/${agentKey}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...policy, enabled: next }),
      })
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string }
        if (payload.error === 'feature_disabled') {
          throw new Error(t('setup.agents.overview.featureOffError'))
        }
        throw new Error(payload.error ?? t('setup.agents.overview.toggleFailed'))
      }
      toast.success(
        t(next ? 'setup.agents.overview.enabled' : 'setup.agents.overview.disabled', {
          name: t(`setup.agents.packs.${agentKey}.title`),
        }),
      )
      router.refresh()
    } catch (e) {
      setPolicies((current) => ({ ...current, [agentKey]: policy }))
      toast.error((e as Error).message)
    } finally {
      setPending(null)
    }
  }

  async function runNow(agentKey: string) {
    if (pending || running) return
    setRunning(agentKey)
    try {
      const res = await fetch(`/api/admin/setup/agents/${agentKey}/run`, { method: 'POST' })
      const payload = (await res.json().catch(() => ({}))) as { detected?: number }
      if (!res.ok) throw new Error(t('setup.agents.overview.scanFailed'))
      toast.success(t('setup.agents.overview.scanComplete', { count: payload.detected ?? 0 }))
      router.refresh()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setRunning(null)
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">{t('setup.agents.overview.title')}</h2>
            <p className="mt-1 max-w-2xl text-sm text-slate-500 dark:text-slate-400">
              {t('setup.agents.overview.description')}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Link
              href="/admin/setup/agents/library"
              className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              <BookOpen size={15} /> {t('setup.agents.nav.library')}
            </Link>
            <Link
              href="/admin/setup/agents/activity"
              className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              <History size={15} /> {t('setup.agents.nav.activity')}
            </Link>
            <Link
              href="/docs/setup-agents-group"
              className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              <BookOpen size={15} /> {t('setup.agents.overview.guideLink')}
            </Link>
          </div>
        </div>
      </div>

      {!featureEnabled ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
          {t('setup.agents.overview.featureOff')}{' '}
          <Link href="/admin/setup/features" className="font-medium underline">
            {t('setup.agents.overview.enableModule')}
          </Link>
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {rows.map((row) => {
          const policy = policies[row.agentKey] ?? row.policy
          const Icon = ICONS[row.agentKey] ?? Puzzle
          const activeDetectors = policy.detectors.filter((detector) => detector.enabled).length
          return (
            <div
              key={row.agentKey}
              className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"
            >
              <div className="flex items-start gap-3">
                <div
                  className={cn(
                    'mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors',
                    policy.enabled
                      ? 'bg-teal-50 text-teal-600 dark:bg-teal-950/50 dark:text-teal-300'
                      : 'bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500',
                  )}
                >
                  <Icon size={18} aria-hidden />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                      {t(`setup.agents.packs.${row.agentKey}.title`)}
                    </span>
                    <Badge variant={policy.enabled ? 'success' : 'secondary'}>
                      {t(`setup.agents.overview.${policy.enabled ? 'enabled' : 'disabled'}`)}
                    </Badge>
                    <Badge variant="outline">
                      {policy.automaticRuns
                        ? t(`setup.agents.overview.cadences.${policy.cadence}`)
                        : t('setup.agents.overview.manualOnly')}
                    </Badge>
                  </div>
                  <p className="mt-0.5 text-xs leading-5 text-slate-500 dark:text-slate-400">
                    {t(`setup.agents.packs.${row.agentKey}.description`)}
                  </p>
                </div>
                <Switch
                  on={policy.enabled}
                  disabled={!featureEnabled || pending !== null || running !== null}
                  onToggle={() => void toggle(row.agentKey)}
                  label={t(`setup.agents.packs.${row.agentKey}.title`)}
                />
              </div>

              <div className="space-y-1 text-xs text-slate-500 dark:text-slate-400">
                <p>
                  {t('setup.agents.overview.controlsEnabled', {
                    count: activeDetectors,
                    total: policy.detectors.length,
                  })}
                  {' · '}
                  {t('setup.agents.overview.materialitySummary', { amount: policy.materialityThreshold })}
                </p>
                <p>
                  {row.lastRun
                    ? t('setup.agents.overview.lastRun', {
                        date: new Date(row.lastRun.startedAt).toLocaleString(),
                        status: t(`setup.agents.overview.runStatus.${row.lastRun.status}`),
                      })
                    : t('setup.agents.overview.neverRun')}
                  {row.policy.nextRunAt && featureEnabled && policy.enabled && policy.automaticRuns ? (
                    <>{' · '}{t('setup.agents.overview.nextRun', { date: new Date(row.policy.nextRunAt).toLocaleString() })}</>
                  ) : null}
                </p>
                <p>
                  {t('setup.agents.overview.openFindings', { count: row.openFindings })}{' '}
                  <Link href="/continuous-close" className="font-medium text-teal-700 underline dark:text-teal-300">
                    {t('setup.agents.overview.reviewWork')}
                  </Link>
                </p>
              </div>

              <div className="flex items-center gap-2">
                <Link
                  href={`/admin/setup/agents/${row.agentKey}`}
                  className="text-xs font-medium text-teal-700 underline dark:text-teal-300"
                >
                  {t('setup.agents.overview.configure')}
                </Link>
                <span className="flex-1" />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!featureEnabled || !policy.enabled || pending !== null || running !== null}
                  onClick={() => void runNow(row.agentKey)}
                >
                  {running === row.agentKey ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
                  {t('setup.agents.overview.runNow')}
                </Button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Accessible on/off switch (role=switch), teal when on — the Features switch. */
function Switch({
  on,
  disabled,
  onToggle,
  label,
}: {
  on: boolean
  disabled: boolean
  onToggle: () => void
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        'relative mt-0.5 inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900',
        on ? 'bg-teal-600 dark:bg-teal-500' : 'bg-slate-200 dark:bg-slate-700',
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
      )}
    >
      <span
        className={cn(
          'inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition-transform',
          on ? 'translate-x-[18px]' : 'translate-x-0.5',
        )}
      />
    </button>
  )
}

'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import {
  ArrowLeft,
  ArrowLeftRight,
  CircleDollarSign,
  ClipboardCheck,
  Landmark,
  Puzzle,
  Receipt,
  TrendingUp,
  type LucideIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge, Button, cn } from '@openbooks/ui'

/** Serializable slice of one pack's policy — the JSON the loader hands over. */
export type AgentLibraryPolicy = {
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

export type AgentLibraryPack = {
  agentKey: string
  enabled: boolean
  policy: AgentLibraryPolicy
  readPermissions: string[]
  detectors: { detectorKey: string; supportsMateriality: boolean }[]
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
 * The Agents library — one section per pack from the registry: what it reads,
 * what it proposes, what it needs (module + permissions), and its checks,
 * with install/enable from here. Installing PUTs the engine default policy
 * the loader hands over with enabled flipped on, so install and configure
 * share the same command and audit shape. Detector titles come from the same
 * `ai.agents.detectors` copy the provider drawer reads.
 */
export function AgentsLibraryWorkspace({
  packs,
  featureEnabled,
}: {
  packs: AgentLibraryPack[]
  featureEnabled: boolean
}) {
  const t = useTranslations('admin')
  const router = useRouter()
  const [enabled, setEnabled] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(packs.map((pack) => [pack.agentKey, pack.enabled])),
  )
  const [pending, setPending] = useState<string | null>(null)

  async function install(pack: AgentLibraryPack) {
    if (pending) return
    if (!featureEnabled) return
    setEnabled((current) => ({ ...current, [pack.agentKey]: true }))
    setPending(pack.agentKey)
    try {
      const res = await fetch(`/api/admin/setup/agents/${pack.agentKey}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...pack.policy, enabled: true }),
      })
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(
          payload.error === 'feature_disabled'
            ? t('setup.agents.overview.featureOffError')
            : (payload.error ?? t('setup.agents.library.installFailed')),
        )
      }
      toast.success(
        t('setup.agents.library.installedToast', { name: t(`setup.agents.packs.${pack.agentKey}.title`) }),
      )
      router.refresh()
    } catch (e) {
      setEnabled((current) => ({ ...current, [pack.agentKey]: pack.enabled }))
      toast.error((e as Error).message)
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">{t('setup.agents.library.title')}</h2>
            <p className="mt-1 max-w-2xl text-sm text-slate-500 dark:text-slate-400">
              {t('setup.agents.library.description')}
            </p>
          </div>
          <Link
            href="/admin/setup/agents"
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            <ArrowLeft size={15} /> {t('setup.agents.nav.overview')}
          </Link>
        </div>
      </div>

      <div className="space-y-3">
        {packs.map((pack) => {
          const Icon = ICONS[pack.agentKey] ?? Puzzle
          const isOn = enabled[pack.agentKey] ?? pack.enabled
          const activeDetectors = pack.policy.detectors.filter((detector) => detector.enabled).length
          return (
            <section
              key={pack.agentKey}
              className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"
            >
              <div className="flex items-start gap-3">
                <div
                  className={cn(
                    'mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors',
                    isOn
                      ? 'bg-teal-50 text-teal-600 dark:bg-teal-950/50 dark:text-teal-300'
                      : 'bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500',
                  )}
                >
                  <Icon size={18} aria-hidden />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                      {t(`setup.agents.packs.${pack.agentKey}.title`)}
                    </span>
                    <Badge variant={isOn ? 'success' : 'secondary'}>
                      {t(`setup.agents.library.${isOn ? 'installed' : 'install'}`)}
                    </Badge>
                    <code className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                      {pack.agentKey}
                    </code>
                  </div>
                  <p className="mt-0.5 text-xs leading-5 text-slate-500 dark:text-slate-400">
                    {t(`setup.agents.packs.${pack.agentKey}.description`)}
                  </p>
                  <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
                    {t('setup.agents.library.registryNote', { key: pack.agentKey, count: pack.detectors.length })}
                  </p>
                </div>
                {isOn ? (
                  <Link
                    href={`/admin/setup/agents/${pack.agentKey}`}
                    className="shrink-0 text-xs font-medium text-teal-700 underline dark:text-teal-300"
                  >
                    {t('setup.agents.library.configure')}
                  </Link>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!featureEnabled || pending !== null}
                    onClick={() => void install(pack)}
                  >
                    {t('setup.agents.library.install')}
                  </Button>
                )}
              </div>

              <dl className="grid gap-3 text-xs sm:grid-cols-2">
                <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-800/50">
                  <dt className="font-semibold text-slate-700 dark:text-slate-200">{t('setup.agents.library.readsLabel')}</dt>
                  <dd className="mt-0.5 leading-5 text-slate-500 dark:text-slate-400">
                    {t(`setup.agents.packs.${pack.agentKey}.reads`)}
                  </dd>
                </div>
                <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-800/50">
                  <dt className="font-semibold text-slate-700 dark:text-slate-200">{t('setup.agents.library.proposesLabel')}</dt>
                  <dd className="mt-0.5 leading-5 text-slate-500 dark:text-slate-400">
                    {t(`setup.agents.packs.${pack.agentKey}.proposes`)}
                  </dd>
                </div>
              </dl>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400">
                <span>
                  {t('setup.agents.library.moduleRequires', { feature: t('features.continuousClose.title') })}
                </span>
                <span>
                  {t('setup.agents.library.needsLabel')}{' '}
                  {pack.readPermissions.map((permission) => (
                    <code
                      key={permission}
                      className="mr-1 rounded bg-slate-100 px-1.5 py-0.5 text-slate-500 dark:bg-slate-800 dark:text-slate-400"
                    >
                      {permission}
                    </code>
                  ))}
                </span>
              </div>

              <div>
                <h3 className="px-1 text-xs font-semibold text-slate-700 dark:text-slate-200">
                  {t('setup.agents.library.checksTitle', { count: pack.detectors.length })}
                </h3>
                <ul className="mt-1.5 divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-100 dark:divide-slate-800 dark:border-slate-800">
                  {pack.detectors.map((detector) => (
                    <li key={detector.detectorKey} className="px-3 py-2">
                      <p className="text-xs font-medium text-slate-700 dark:text-slate-200">
                        {t(`ai.agents.detectors.${detector.detectorKey}.title`)}
                      </p>
                      <p className="mt-0.5 text-[11px] leading-4 text-slate-500 dark:text-slate-400">
                        {t(`ai.agents.detectors.${detector.detectorKey}.description`)}
                      </p>
                    </li>
                  ))}
                </ul>
                <p className="mt-1 px-1 text-[11px] text-slate-400 dark:text-slate-500">
                  {t('setup.agents.library.checksNote', { count: activeDetectors, total: pack.policy.detectors.length })}
                </p>
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}

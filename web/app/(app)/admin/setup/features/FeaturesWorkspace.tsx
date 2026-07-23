'use client'

import { useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import {
  Boxes,
  Briefcase,
  Building2,
  CalendarCheck,
  CircleDollarSign,
  ClipboardList,
  Clock,
  LayoutGrid,
  Landmark,
  Lock,
  Package,
  Puzzle,
  Radio,
  Receipt,
  Repeat2,
  ShoppingCart,
  Target,
  TrendingUp,
  Users,
  Workflow,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@openbooks/ui'

type Feature = { key: string; category: string; enabled: boolean }
type Impact = { labelKey: string; count: number }
type DisableStatus = { blocked: boolean; impacts: Impact[] }

/** Icon per feature — falls back to a neutral square when unmapped. */
const ICONS: Record<string, LucideIcon> = {
  crm: Users,
  orders: ShoppingCart,
  revenueRecognition: TrendingUp,
  subscriptionBilling: Repeat2,
  projects: Briefcase,
  timeTracking: Clock,
  fieldTickets: ClipboardList,
  inventory: Package,
  equipment: Wrench,
  expenses: Receipt,
  multiSubsidiary: Building2,
  multiCurrency: CircleDollarSign,
  banking: Landmark,
  bankFeeds: Radio,
  fixedAssets: Boxes,
  budgets: Target,
  continuousClose: CalendarCheck,
  flows: Workflow,
  apps: LayoutGrid,
}

const CATEGORY_ORDER = ['sales', 'operations', 'accounting', 'platform'] as const

/**
 * The Features switchboard — a grouped settings list (icon · name · description ·
 * switch), one panel per category. Saves on toggle; nav re-renders so gated
 * modules appear/disappear. Turning a feature off surfaces what it affects:
 * integrity-critical features (e.g. multi-subsidiary once posted-to) lock; the
 * rest confirm, listing the records that will be hidden.
 */
export function FeaturesWorkspace({
  features,
  disableStatus = {},
}: {
  features: Feature[]
  disableStatus?: Record<string, DisableStatus>
}) {
  const t = useTranslations('admin')
  const router = useRouter()
  const [state, setState] = useState<Record<string, boolean>>(
    () => Object.fromEntries(features.map((f) => [f.key, f.enabled])),
  )
  const [pending, setPending] = useState<string | null>(null)

  /** Comma-joined "12 reconciliations, 340 bank statements" from a feature's impacts. */
  const impactText = (impacts: Impact[]) =>
    impacts.map((i) => t(`setup.features.impacts.${i.labelKey}`, { count: i.count })).join(', ')

  async function toggle(key: string) {
    if (pending) return
    const status = disableStatus[key]
    const next = !state[key]

    if (!next) {
      if (state[key] && status?.blocked) return // locked — shouldn't reach here
      // Confirm before hiding real records.
      if (status && status.impacts.length > 0) {
        const ok = window.confirm(
          t('setup.features.confirmDisable', {
            name: t(`features.${key}.title`),
            items: impactText(status.impacts),
          }),
        )
        if (!ok) return
      }
    }

    setState((s) => ({ ...s, [key]: next }))
    setPending(key)
    try {
      const res = await fetch('/api/admin/setup/features', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ features: { [key]: next } }),
      })
      if (!res.ok) {
        const code = (await res.json().catch(() => ({})))?.error
        throw new Error(
          code === 'feature-blocked' ? t('setup.features.errors.blocked') : (code ?? t('setup.features.errors.blocked')),
        )
      }
      toast.success(t(next ? 'setup.features.enabled' : 'setup.features.disabled', { name: t(`features.${key}.title`) }))
      router.refresh()
    } catch (e) {
      setState((s) => ({ ...s, [key]: !next }))
      toast.error((e as Error).message)
    } finally {
      setPending(null)
    }
  }

  const categories = CATEGORY_ORDER.filter((c) => features.some((f) => f.category === c))

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">{t('setup.features.title')}</h2>
        <p className="mt-1 max-w-2xl text-sm text-slate-500 dark:text-slate-400">
          {t('setup.features.description')}
        </p>
      </div>

      {categories.map((cat) => {
        const rows = features.filter((f) => f.category === cat)
        const on = rows.filter((f) => state[f.key]).length
        return (
          <section key={cat} className="space-y-2.5">
            <div className="flex items-baseline justify-between px-1">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                {t(`setup.features.categories.${cat}`)}
              </h3>
              <span className="text-xs tabular-nums text-slate-400 dark:text-slate-500">
                {t('setup.features.countOn', { n: on, total: rows.length })}
              </span>
            </div>
            <div className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
              {rows.map((f) => {
                const status = disableStatus[f.key]
                const isOn = Boolean(state[f.key])
                const blocked = isOn && Boolean(status?.blocked)
                const impacts = status?.impacts ?? []
                return (
                  <FeatureRow
                    key={f.key}
                    icon={ICONS[f.key] ?? Puzzle}
                    title={t(`features.${f.key}.title`)}
                    description={t(`features.${f.key}.description`)}
                    on={isOn}
                    blocked={blocked}
                    reason={
                      blocked
                        ? t('setup.features.blockedReason', { items: impactText(impacts) })
                        : isOn && impacts.length > 0
                          ? t('setup.features.affectsNote', { items: impactText(impacts) })
                          : undefined
                    }
                    reasonTone={blocked ? 'block' : 'info'}
                    busy={pending === f.key}
                    disabled={pending !== null && pending !== f.key}
                    onToggle={() => toggle(f.key)}
                  />
                )
              })}
            </div>
          </section>
        )
      })}
    </div>
  )
}

function FeatureRow({
  icon: Icon,
  title,
  description,
  on,
  blocked,
  reason,
  reasonTone,
  busy,
  disabled,
  onToggle,
}: {
  icon: LucideIcon
  title: string
  description: string
  on: boolean
  blocked: boolean
  reason?: string
  reasonTone: 'block' | 'info'
  busy: boolean
  disabled: boolean
  onToggle: () => void
}) {
  return (
    <div className="flex items-start gap-4 p-4">
      <div
        className={cn(
          'mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors',
          on
            ? 'bg-teal-50 text-teal-600 dark:bg-teal-950/50 dark:text-teal-300'
            : 'bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500',
        )}
      >
        <Icon size={18} aria-hidden />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-slate-900 dark:text-slate-100">{title}</span>
          {blocked ? (
            <Lock size={12} className="shrink-0 text-slate-400 dark:text-slate-500" aria-hidden />
          ) : null}
        </div>
        <p className="mt-0.5 text-xs leading-5 text-slate-500 dark:text-slate-400">{description}</p>
        {reason ? (
          <p
            className={cn(
              'mt-1.5 text-xs font-medium',
              reasonTone === 'block'
                ? 'text-amber-600 dark:text-amber-400'
                : 'text-slate-400 dark:text-slate-500',
            )}
          >
            {reason}
          </p>
        ) : null}
      </div>

      <Switch on={on} disabled={blocked || busy || disabled} onToggle={onToggle} label={title} />
    </div>
  )
}

/** Accessible on/off switch (role=switch), teal when on. */
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
}): ReactNode {
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

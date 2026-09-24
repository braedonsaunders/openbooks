'use client'

import { useState, type ReactNode } from 'react'
import Link from 'next/link'
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
  Code2,
  Clock,
  Database,
  LayoutGrid,
  Landmark,
  KeyRound,
  Lock,
  Package,
  Puzzle,
  PlugZap,
  Radio,
  Receipt,
  Repeat2,
  ShoppingCart,
  Sparkles,
  Target,
  TrendingUp,
  Users,
  Workflow,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@openbooks/ui'
import { confirmDialog } from '../../../../../lib/confirm'
import { buildFeatureTree, featureToggleRefusalMessage, type FeatureTreeNode } from './feature-tree'

type Feature = {
  key: string
  category: string
  enabled: boolean
  parentKey?: string
  requiresAll?: string[]
  recommends?: string[]
}
type Impact = { labelKey: string; count: number }
type DisableStatus = { blocked: boolean; impacts: Impact[] }

/** Icon per feature — falls back to a neutral square when unmapped. */
const ICONS: Record<string, LucideIcon> = {
  crm: Users,
  orders: ShoppingCart,
  revenueRecognition: TrendingUp,
  subscriptionBilling: Repeat2,
  advancedSubscriptions: Repeat2,
  projects: Briefcase,
  timeTracking: Clock,
  fieldTickets: ClipboardList,
  subcontracts: ClipboardList,
  wipBilling: CircleDollarSign,
  propertyManagement: Building2,
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
  scripts: Code2,
  apiAccess: KeyRound,
  mcpAccess: PlugZap,
  queryConsole: Database,
}

const CATEGORY_ORDER = ['sales', 'operations', 'accounting', 'platform'] as const

/**
 * The Features switchboard — a grouped settings list (icon · name · description ·
 * switch), one panel per category. Saves on toggle; nav re-renders so gated
 * modules appear/disappear. Turning a feature off surfaces what it affects:
 * integrity-critical features (e.g. multi-subsidiary once posted-to) lock; the
 * rest confirm, listing the records that will be hidden.
 *
 * Hierarchy: features that declare a `parentKey` render NESTED under their
 * parent row — indented, smaller, behind a quiet rail — and are not rendered
 * at all while the parent is off. The parent row then carries a
 * "N options once enabled" hint instead. Hiding is presentation only: stored
 * values are untouched, so re-enabling the parent restores its children.
 * `requiresAll` entries are cross-module requirements, not children, and stay
 * top-level rows with their "Requires X" reason. Category counts cover only
 * visible rows so the header numbers stay honest.
 */
export function FeaturesWorkspace({
  features,
  disableStatus = {},
  wizardHref,
}: {
  features: Feature[]
  disableStatus?: Record<string, DisableStatus>
  wizardHref?: string
}) {
  const t = useTranslations('admin')
  const router = useRouter()
  const [state, setState] = useState<Record<string, boolean>>(
    () => Object.fromEntries(features.map((f) => [f.key, f.enabled])),
  )
  const [pending, setPending] = useState<string | null>(null)

  // Re-sync from the server after router.refresh(): a toggle commits on the
  // server, and derived rows (children of a freshly enabled parent, or rows
  // whose requirements just resolved) read differently there than in this
  // island's initial snapshot. Adjusted during render (never in an effect),
  // and never while an optimistic toggle is in flight.
  const [syncedFeatures, setSyncedFeatures] = useState(features)
  if (syncedFeatures !== features && pending === null) {
    setSyncedFeatures(features)
    setState(Object.fromEntries(features.map((f) => [f.key, f.enabled])))
  }

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
        const ok = await confirmDialog({
          message: t('setup.features.confirmDisable', {
            name: t(`features.${key}.title`),
            items: impactText(status.impacts),
          }),
          tone: 'danger',
        })
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
        const payload = await res.json().catch(() => ({}))
        throw new Error(featureToggleRefusalMessage(payload, (key, params) => t(key, params)))
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

  // Nested sections: children attach to their parent's group (in registry
  // order) and vanish — from the page AND the counts — while the parent is off.
  const sections = buildFeatureTree(features, state, CATEGORY_ORDER)

  /** One switchboard row: parent rows full-size, nested children compact. */
  const renderRow = (node: FeatureTreeNode, compact: boolean, hintCount = 0) => {
    const f = node.row
    const status = disableStatus[f.key]
    const missingRequirements = node.missingRequirements
    const dependencyLocked = missingRequirements.length > 0
    const isOn = node.on
    const missingRecommendations = (f.recommends ?? []).filter((key) => !state[key])
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
        compact={compact}
        reason={
          dependencyLocked
            ? t('setup.features.requiresNote', { names: missingRequirements.map((key) => t(`features.${key}.title`)).join(', ') })
            : hintCount > 0
              ? t('setup.features.childOptions', { count: hintCount })
              : blocked
                ? t('setup.features.blockedReason', { items: impactText(impacts) })
                : isOn && impacts.length > 0
                  ? t('setup.features.affectsNote', { items: impactText(impacts) })
                  : isOn && missingRecommendations.length > 0
                    ? t('setup.features.recommendsNote', { names: missingRecommendations.map((key) => t(`features.${key}.title`)).join(', ') })
                    : undefined
        }
        reasonTone={blocked || dependencyLocked ? 'block' : 'info'}
        busy={pending === f.key}
        disabled={dependencyLocked || (pending !== null && pending !== f.key)}
        onToggle={() => toggle(f.key)}
      />
    )
  }

  return (
    <div className="space-y-8">
      <div>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">{t('setup.features.title')}</h2>
            <p className="mt-1 max-w-2xl text-sm text-slate-500 dark:text-slate-400">
              {t('setup.features.description')}
            </p>
          </div>
          {wizardHref && (
            <Link
              href={wizardHref}
              className="flex shrink-0 items-center gap-1.5 rounded-lg border border-teal-200 bg-teal-50 px-3 py-2 text-sm font-medium text-teal-700 transition-colors hover:bg-teal-100 dark:border-teal-800 dark:bg-teal-950/40 dark:text-teal-300 dark:hover:bg-teal-950/60"
            >
              <Sparkles size={15} /> {t('setup.features.runWizard')}
            </Link>
          )}
        </div>
      </div>

      {sections.map((section) => (
        <section key={section.category} className="space-y-2.5">
          <div className="flex items-baseline justify-between px-1">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              {t(`setup.features.categories.${section.category}`)}
            </h3>
            <span className="text-xs tabular-nums text-slate-400 dark:text-slate-500">
              {t('setup.features.countOn', { n: section.visibleOn, total: section.visibleTotal })}
            </span>
          </div>
          <div className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
            {section.groups.map((group) => (
              <div key={group.parent.row.key}>
                {renderRow(group.parent, false, group.hiddenChildCount)}
                {group.visibleChildren.length > 0 && (
                  <div className="border-t border-slate-100 dark:border-slate-800">
                    <div className="ml-12 border-l border-slate-200 pl-1 dark:border-slate-700">
                      {group.visibleChildren.map((child, index) => (
                        <div
                          key={child.row.key}
                          className={cn(
                            index > 0 && 'border-t border-slate-100 dark:border-slate-800',
                          )}
                        >
                          {renderRow(child, true)}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      ))}
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
  compact = false,
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
  /** Nested child row: no icon square, tighter padding, secondary type. */
  compact?: boolean
}) {
  return (
    <div className={cn('flex items-start', compact ? 'gap-3 py-3 pl-4 pr-4' : 'gap-4 p-4')}>
      {compact ? null : (
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
      )}

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'font-medium',
              compact
                ? 'text-[13px] text-slate-800 dark:text-slate-200'
                : 'text-sm text-slate-900 dark:text-slate-100',
            )}
          >
            {title}
          </span>
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

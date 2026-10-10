'use client'

import type { ReactNode } from 'react'
import {
  BadgePercent,
  Banknote,
  BarChart3,
  Boxes,
  Briefcase,
  Building,
  Building2,
  CalendarCheck,
  ChartLine,
  CircleDollarSign,
  Code2,
  Coins,
  CreditCard,
  Database,
  Factory,
  FileSignature,
  Gauge,
  Gift,
  Globe,
  Handshake,
  Hash,
  HeartHandshake,
  History,
  IdCard,
  KeyRound,
  Landmark,
  Layers,
  LayoutGrid,
  Lock,
  Megaphone,
  Network,
  Package,
  PackageCheck,
  PlugZap,
  Radio,
  Receipt,
  RefreshCcw,
  Repeat2,
  ScanBarcode,
  ScrollText,
  Shapes,
  ShieldCheck,
  ShoppingCart,
  Split,
  Store,
  Target,
  TrendingUp,
  Truck,
  Undo2,
  Users,
  Wallet,
  Warehouse,
  Webhook,
  Workflow,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@openbooks/ui'
import { FEATURE_GROUPS, type FeatureCategory } from '@openbooks/engine/organization/feature-catalog'
import { Switch } from '@/components/switch'
import { groupFeatureChildren, type FeatureTreeNode, type FeatureTreeSection } from './feature-tree'

/**
 * The feature switchboard's presentation, shared by Company Settings →
 * Features and the setup wizard's "pick my own features" step so both show
 * the same rows, nesting and requirement reasons over the same registry tree
 * (`buildFeatureTree`). Persistence stays with each host: the switchboard
 * saves a toggle immediately, the wizard collects choices until apply.
 */

/** Icon per top-level feature row (nested rows render without one) — falls
 *  back to a neutral puzzle piece when unmapped. */
export const FEATURE_ICONS: Record<string, LucideIcon> = {
  // Finance
  multiSubsidiary: Building2,
  multiCurrency: Coins,
  banking: Landmark,
  bankFeeds: Radio,
  fixedAssets: Boxes,
  budgets: Target,
  allocations: Split,
  crossBorderTax: Globe,
  continuousClose: CalendarCheck,
  advancedClose: ShieldCheck,
  // Sales
  crm: Users,
  orders: ShoppingCart,
  customerPartNumbers: Hash,
  promotions: BadgePercent,
  cashSales: Banknote,
  storedValue: Gift,
  salesChannels: Store,
  // Billing
  subscriptionBilling: Repeat2,
  advancedSubscriptions: Layers,
  usageBilling: Gauge,
  quoteToCash: FileSignature,
  consolidatedBilling: Network,
  saasMetrics: ChartLine,
  billingHistoryImport: History,
  onlinePayments: CreditCard,
  autopay: RefreshCcw,
  revenueRecognition: TrendingUp,
  contractCosts: CircleDollarSign,
  // Inventory
  inventory: Package,
  itemVariants: Shapes,
  barcodeScanning: ScanBarcode,
  warehousing: Warehouse,
  fulfillment: PackageCheck,
  returnAuthorizations: Undo2,
  dropShipping: Truck,
  demandPlanning: BarChart3,
  // Manufacturing
  manufacturing: Factory,
  // Projects
  projects: Briefcase,
  preBilling: CircleDollarSign,
  subcontracts: Handshake,
  subcontractorCompliance: ShieldCheck,
  equipment: Wrench,
  // People
  hrm: IdCard,
  payroll: Wallet,
  expenses: Receipt,
  // Property and nonprofit
  propertyManagement: Building,
  nonprofit: HeartHandshake,
  // Platform
  flows: Workflow,
  homeAnnouncements: Megaphone,
  aiGovernanceLedger: ScrollText,
  apps: LayoutGrid,
  scripts: Code2,
  apiAccess: KeyRound,
  outboundWebhooks: Webhook,
  mcpAccess: PlugZap,
  queryConsole: Database,
}

type Translate = (key: string, params?: Record<string, string | number>) => string

/**
 * The explanatory line under a row, in the switchboard's priority order: a
 * missing requirement first (the row is locked), then hidden child options,
 * then a disable block, the records it affects, and finally unmet
 * recommendations. `t` resolves keys under the `admin` namespace.
 */
export function featureRowReason(args: {
  node: FeatureTreeNode
  hintCount: number
  state: Readonly<Record<string, boolean>>
  t: Translate
  blocked?: boolean
  impacts?: string | null
}): { reason?: string; tone: 'block' | 'info' } {
  const { node, hintCount, state, t } = args
  const titles = (keys: string[]) => keys.map((key) => t(`features.${key}.title`)).join(', ')
  const dependencyLocked = node.missingRequirements.length > 0
  const tone = args.blocked || dependencyLocked ? 'block' : 'info'
  const missingRecommendations = (node.row.recommends ?? []).filter((key) => !state[key])
  const reason = dependencyLocked
    ? t('setup.features.requiresNote', { names: titles(node.missingRequirements) })
    : hintCount > 0
      ? t('setup.features.childOptions', { count: hintCount })
      : args.blocked
        ? t('setup.features.blockedReason', { items: args.impacts ?? '' })
        : node.on && args.impacts
          ? t('setup.features.affectsNote', { items: args.impacts })
          : node.on && missingRecommendations.length > 0
            ? t('setup.features.recommendsNote', { names: titles(missingRecommendations) })
            : undefined
  return { reason, tone }
}

/** A registry presentation group's heading; unknown groups read as "Other". */
export function featureGroupLabel(t: Translate & { has: (key: string) => boolean }, group: string): string {
  return t.has(`setup.features.groups.${group}`) ? t(`setup.features.groups.${group}`) : t('setup.features.groups.other')
}

/**
 * One bordered panel: each parent row, then its visible children on a rail,
 * under their registry presentation subgroups when a parent spans several.
 */
export function FeatureTreePanel({
  section,
  renderRow,
  groupLabel,
}: {
  section: FeatureTreeSection
  renderRow: (node: FeatureTreeNode, compact: boolean, hintCount: number) => ReactNode
  groupLabel: (group: string) => string
}) {
  return (
    <div className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
      {section.groups.map((group) => (
        <div key={group.parent.row.key}>
          {renderRow(group.parent, false, group.hiddenChildCount)}
          {group.visibleChildren.length > 0 && (
            <div className="border-t border-slate-100 dark:border-slate-800">
              <div className="ml-12 border-l border-slate-200 pl-1 dark:border-slate-700">
                {groupFeatureChildren(group.visibleChildren, group.parent.row.group,
                  FEATURE_GROUPS[group.parent.row.category as FeatureCategory] ?? []).map((subgroup, groupIndex, subgroups) => (
                    <div key={subgroup.key}>
                      {subgroups.length > 1 ? <h4 className="px-4 pb-1 pt-3 text-xs font-semibold text-slate-500 dark:text-slate-400">{groupLabel(subgroup.key)}</h4> : null}
                      {subgroup.children.map((child, index) => (
                        <div key={child.row.key} className={cn((index > 0 || groupIndex > 0) && 'border-t border-slate-100 dark:border-slate-800')}>
                          {renderRow(child, true, 0)}
                        </div>
                      ))}
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

export function FeatureRow({
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
  depth = 0,
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
  depth?: number
}) {
  return (
    <div
      className={cn('flex items-start', compact ? 'gap-3 py-3 pr-4' : 'gap-4 p-4')}
      style={compact ? { paddingLeft: `${16 + Math.max(0, depth - 1) * 24}px` } : undefined}
    >
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

      <Switch on={on} disabled={blocked || busy || disabled} onToggle={onToggle} label={title} className="mt-0.5" />
    </div>
  )
}

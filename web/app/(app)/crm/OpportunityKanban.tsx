'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import {
  AlertTriangle,
  Calendar,
  User,
  Search,
  Building,
} from 'lucide-react'
import {
  Badge,
  Button,
  Card,
  Input,
  Label,
  Select,
  Textarea,
  cn,
} from '@openbooks/ui'
import { toast } from 'sonner'
import { displayOpportunityStatusName } from '../../../lib/crm-status-display'
import { isPositiveKanbanAmount, sumKanbanColumnByCurrency } from '../../../lib/crm-kanban-totals'
import { createMoneyFormatter } from '../../../lib/money-format'
import { useBusinessToday } from '../../../components/business-date-provider'

export interface KanbanStatus {
  id: string
  key: string
  name: string
  sequence: number
  probability: number
  defaultForecastCategory: string
  isClosed: boolean
  isWon: boolean
  requiresLines?: boolean
  requiresPrimaryContact?: boolean
  requiresPositiveAmount?: boolean
  requiresWinLossReason?: boolean
}

export interface KanbanOpportunity {
  id: string
  opportunityNumber: string
  title: string
  partyId: string | null
  partyName: string | null
  primaryContactId: string | null
  contactName: string | null
  ownerUserId: string | null
  ownerName: string | null
  salesTeamName: string | null
  statusId: string
  forecastCategory: string
  probability: number
  currency: string
  projectedAmount: string
  weightedAmount: string
  expectedCloseDate: string | null
  nextStep: string | null
  winLossReason: string | null
  updatedAt: string
  isStagnant: boolean
  linesCount: number
}

export function OpportunityViewSwitcher({ view = 'list' }: { view?: 'board' | 'list' }) {
  const router = useRouter()
  return (
    <div className="inline-flex items-center rounded-lg border border-slate-200 bg-slate-50 p-1 text-xs font-medium dark:border-slate-800 dark:bg-slate-900">
      <button
        type="button"
        onClick={() => router.push('/crm/opportunities?view=list')}
        className={cn(
          'flex items-center gap-1.5 rounded-md px-2.5 py-1 transition-colors',
          view === 'list'
            ? 'bg-white shadow-sm dark:bg-slate-800 text-slate-900 dark:text-slate-100 font-semibold'
            : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200',
        )}
      >
        <span>List</span>
      </button>
      <button
        type="button"
        onClick={() => router.push('/crm/opportunities?view=board')}
        className={cn(
          'flex items-center gap-1.5 rounded-md px-2.5 py-1 transition-colors',
          view === 'board'
            ? 'bg-white shadow-sm dark:bg-slate-800 text-slate-900 dark:text-slate-100 font-semibold'
            : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200',
        )}
      >
        <span>Pipeline Board</span>
      </button>
    </div>
  )
}

const moneyFormatters = new Map<string, (amount: string) => string>()

function formatMoney(amount: string, currency: string): string {
  let format = moneyFormatters.get(currency)
  if (!format) {
    format = (value: string) => createMoneyFormatter('en-US', currency).money(value, { maximumFractionDigits: 0 })
    moneyFormatters.set(currency, format)
  }
  return format(amount)
}

export function OpportunityKanbanBoard({
  statuses,
  opportunities,
  canManage,
  drawerSlot,
  undatedOnly = false,
  undatedLabel = '',
  showAllLabel = '',
}: {
  statuses: KanbanStatus[]
  opportunities: KanbanOpportunity[]
  canManage: boolean
  drawerSlot?: React.ReactNode
  /** Server-side `undated=1` filter from the forecast exclusion note. */
  undatedOnly?: boolean
  undatedLabel?: string
  showAllLabel?: string
}) {
  const t = useTranslations('crm')
  const tc = useTranslations('common')
  const router = useRouter()
  // Overdue compares calendar days in the org's business day: `new
  // Date('YYYY-MM-DD')` is UTC midnight, so anything due today read as
  // overdue for the whole day. YYYY-MM-DD strings compare lexically.
  const today = useBusinessToday()

  const [search, setSearch] = useState('')
  const [movingId, setMovingId] = useState<string | null>(null)
  const [lossPrompt, setLossPrompt] = useState<{
    opportunityId: string
    targetStatusId: string
    revision: string
    reason: string
  } | null>(null)

  const filteredOpportunities = opportunities.filter((op) => {
    if (!search.trim()) return true
    const q = search.toLowerCase()
    return (
      op.title.toLowerCase().includes(q) ||
      op.opportunityNumber.toLowerCase().includes(q) ||
      (op.partyName && op.partyName.toLowerCase().includes(q)) ||
      (op.ownerName && op.ownerName.toLowerCase().includes(q)) ||
      (op.contactName && op.contactName.toLowerCase().includes(q))
    )
  })

  async function executeStageChange(
    opportunityId: string,
    targetStatusId: string,
    revision: string,
    winLossReason?: string | null,
  ) {
    setMovingId(opportunityId)
    try {
      const response = await fetch(`/api/crm/opportunities/${opportunityId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          statusId: targetStatusId,
          winLossReason: winLossReason || null,
          expectedUpdatedAt: revision,
        }),
      })

      const result = (await response.json().catch(() => null)) as { error?: string } | null
      if (!response.ok) {
        toast.error(result?.error ?? tc('feedback.saveFailed'))
        return
      }

      toast.success(tc('feedback.saved'))
      router.refresh()
    } catch {
      toast.error(tc('feedback.saveFailed'))
    } finally {
      setMovingId(null)
      setLossPrompt(null)
    }
  }

  function handleStageChange(opportunity: KanbanOpportunity, newStatusId: string) {
    if (newStatusId === opportunity.statusId) return
    const targetStatus = statuses.find((s) => s.id === newStatusId)
    if (!targetStatus) return

    // Stage-gating validation
    if (targetStatus.requiresLines && opportunity.linesCount === 0) {
      toast.error('This stage requires at least one line item on the opportunity.')
      return
    }

    if (targetStatus.requiresPrimaryContact && !opportunity.primaryContactId) {
      toast.error('This stage requires an assigned primary contact.')
      return
    }

    if (targetStatus.requiresPositiveAmount && !isPositiveKanbanAmount(opportunity.projectedAmount)) {
      toast.error('This stage requires a positive projected deal amount.')
      return
    }

    const needsLossReason =
      targetStatus.requiresWinLossReason || (targetStatus.isClosed && !targetStatus.isWon)

    if (needsLossReason) {
      setLossPrompt({
        opportunityId: opportunity.id,
        targetStatusId: newStatusId,
        revision: opportunity.updatedAt,
        reason: opportunity.winLossReason || '',
      })
      return
    }

    executeStageChange(opportunity.id, newStatusId, opportunity.updatedAt)
  }

  return (
    <div className="space-y-4">
      {undatedOnly ? (
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{undatedLabel}</Badge>
          <Button variant="ghost" size="sm" onClick={() => router.push('/crm/opportunities?view=board')}>
            {showAllLabel}
          </Button>
        </div>
      ) : null}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full max-w-sm">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <Input
            placeholder="Filter deals by title, account, owner..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="text-xs text-slate-500">
          Showing {filteredOpportunities.length} of {opportunities.length} opportunities
        </div>
      </div>

      {/* Kanban Horizontal Board */}
      <div className="flex gap-4 overflow-x-auto pb-6 pt-1">
        {statuses.map((status) => {
          const colOpps = filteredOpportunities.filter((op) => op.statusId === status.id)
          // Exact per-currency totals: a stage holding CAD 100 and USD 100
          // reports one line per currency, never a converted-looking blend.
          const colTotals = sumKanbanColumnByCurrency(colOpps)

          return (
            <div
              key={status.id}
              className="flex w-80 shrink-0 flex-col rounded-xl border border-slate-200 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-slate-900/60"
            >
              {/* Column Header */}
              <div className="mb-3 border-b border-slate-200/80 pb-2.5 dark:border-slate-800/80">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 truncate font-semibold text-slate-800 dark:text-slate-100">
                    <span className="truncate">
                      {displayOpportunityStatusName(status.name, (key) => t(`opportunities.statuses.${key}`))}
                    </span>
                    <Badge variant={status.isWon ? 'default' : status.isClosed ? 'secondary' : 'outline'} className="text-[10px]">
                      {status.probability}%
                    </Badge>
                  </div>
                  <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                    {colOpps.length}
                  </span>
                </div>
                <div className="mt-1 flex flex-col gap-0.5 text-xs text-slate-500">
                  {colTotals.map((total) => (
                    <div key={total.currency} className="flex items-baseline justify-between">
                      <span className="font-medium text-slate-900 dark:text-slate-200">
                        {formatMoney(total.projected, total.currency)}
                      </span>
                      {isPositiveKanbanAmount(total.weighted) && total.weighted !== total.projected && (
                        <span className="text-[11px] text-slate-400">
                          Weighted: {formatMoney(total.weighted, total.currency)}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Column Cards */}
              <div className="flex flex-1 flex-col gap-2.5 overflow-y-auto">
                {colOpps.map((op) => {
                  const isBusy = movingId === op.id
                  const isOverdue =
                    op.expectedCloseDate != null &&
                    op.expectedCloseDate !== '' &&
                    !status.isClosed &&
                    op.expectedCloseDate < today

                  return (
                    <Card
                      key={op.id}
                      className={cn(
                        'group relative flex flex-col gap-2.5 rounded-lg border border-slate-200/90 bg-white p-3.5 shadow-sm transition hover:border-slate-300 hover:shadow-md dark:border-slate-800 dark:bg-slate-950 dark:hover:border-slate-700',
                        isBusy && 'opacity-60 pointer-events-none',
                      )}
                    >
                      {/* Deal ID & Badges */}
                      <div className="flex items-start justify-between gap-2">
                        <a
                          href={`/crm/opportunities?opportunity=${op.id}&view=board`}
                          className="font-mono text-xs font-semibold text-blue-600 hover:underline dark:text-blue-400"
                        >
                          {op.opportunityNumber}
                        </a>
                        <div className="flex flex-wrap items-center gap-1">
                          {op.isStagnant && !status.isClosed && (
                            <Badge
                              variant="outline"
                              className="border-amber-300 bg-amber-50 px-1.5 py-0 text-[10px] text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
                              title="No recorded activity or stage change in >14 days"
                            >
                              <AlertTriangle className="mr-1 h-3 w-3" />
                              &gt;14d
                            </Badge>
                          )}
                          <Badge variant="secondary" className="px-1.5 py-0 text-[10px] capitalize">
                            {op.forecastCategory.replace('_', ' ')}
                          </Badge>
                        </div>
                      </div>

                      {/* Deal Title */}
                      <a
                        href={`/crm/opportunities?opportunity=${op.id}&view=board`}
                        className="line-clamp-2 text-sm font-semibold text-slate-900 hover:text-blue-600 dark:text-slate-100 dark:hover:text-blue-400"
                      >
                        {op.title}
                      </a>

                      {/* Account & Contact */}
                      <div className="space-y-1 text-xs text-slate-600 dark:text-slate-400">
                        {op.partyName && (
                          <div className="flex items-center gap-1.5 truncate">
                            <Building className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                            <span className="truncate font-medium text-slate-700 dark:text-slate-300">
                              {op.partyName}
                            </span>
                          </div>
                        )}
                        {op.contactName && (
                          <div className="flex items-center gap-1.5 truncate">
                            <User className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                            <span className="truncate">{op.contactName}</span>
                          </div>
                        )}
                      </div>

                      {/* Deal Amount & Projected */}
                      <div className="flex items-baseline justify-between border-t border-slate-100 pt-2 dark:border-slate-800/80">
                        <span className="text-sm font-bold text-slate-900 dark:text-slate-100">
                          {formatMoney(op.projectedAmount, op.currency)}
                        </span>
                        {op.expectedCloseDate && (
                          <div
                            className={cn(
                              'flex items-center gap-1 text-[11px]',
                              isOverdue
                                ? 'font-medium text-rose-600 dark:text-rose-400'
                                : 'text-slate-500',
                            )}
                          >
                            <Calendar className="h-3 w-3" />
                            <span>{op.expectedCloseDate}</span>
                          </div>
                        )}
                      </div>

                      {/* Owner & Stage Quick Switch */}
                      <div className="flex items-center justify-between gap-2 pt-1">
                        <span className="truncate text-[11px] text-slate-500">
                          {op.ownerName || 'Unassigned'}
                        </span>
                        {canManage && (
                          <Select
                            value={op.statusId}
                            onChange={(e) => handleStageChange(op, e.target.value)}
                            disabled={isBusy}
                            className="h-6 w-auto px-2 py-0 text-[11px]"
                          >
                            {statuses.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.name}
                              </option>
                            ))}
                          </Select>
                        )}
                      </div>
                    </Card>
                  )
                })}

                {colOpps.length === 0 && (
                  <div className="flex flex-1 flex-col items-center justify-center rounded-lg border border-dashed border-slate-200 p-6 text-center text-xs text-slate-400 dark:border-slate-800">
                    <p>No opportunities</p>
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Win / Loss Reason Modal Dialog */}
      {lossPrompt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-xl dark:border-slate-800 dark:bg-slate-900">
            <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Win / Loss Reason Required
            </h3>
            <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
              Please document why this opportunity was closed or lost for historical reporting and pipeline analytics.
            </p>
            <div className="mt-4 space-y-1.5">
              <Label className="text-xs">Reason details</Label>
              <Textarea
                rows={4}
                placeholder="e.g. Lost to competitor on price; project budget cancelled; scope reduced..."
                value={lossPrompt.reason}
                onChange={(e) =>
                  setLossPrompt({ ...lossPrompt, reason: e.target.value })
                }
                autoFocus
              />
            </div>
            <div className="mt-5 flex justify-end gap-2.5">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setLossPrompt(null)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  if (!lossPrompt.reason.trim()) {
                    toast.error('A loss reason is required to close as lost.')
                    return
                  }
                  executeStageChange(
                    lossPrompt.opportunityId,
                    lossPrompt.targetStatusId,
                    lossPrompt.revision,
                    lossPrompt.reason,
                  )
                }}
              >
                Confirm Stage Change
              </Button>
            </div>
          </div>
        </div>
      )}

      {drawerSlot}
    </div>
  )
}

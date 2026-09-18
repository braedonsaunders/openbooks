'use client'

import {
  Building,
  Clock,
  FileText,
  Mail,
  Phone,
  Receipt,
  TrendingUp,
  Briefcase,
  ShieldAlert,
} from 'lucide-react'
import {
  Badge,
  Card,
  cn,
} from '@openbooks/ui'
import type { Customer360Data } from '../../../lib/customer-360'

function formatCurrency(amount: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(amount)
}

export function Customer360Cockpit({ data }: { data: Customer360Data }) {
  const { party, aging, credit, paymentMetrics, pipeline, projects, timeline } = data

  return (
    <div className="space-y-6">
      {/* Top Hero Banner */}
      <div className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100">
              {party.displayName}
            </h2>
            {party.isOnHold && (
              <Badge variant="destructive" className="flex items-center gap-1">
                <ShieldAlert className="h-3.5 w-3.5" />
                Credit Hold
              </Badge>
            )}
            <Badge variant="outline">{party.currency}</Badge>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
            {party.email && (
              <span className="flex items-center gap-1">
                <Mail className="h-3.5 w-3.5 text-slate-400" />
                {party.email}
              </span>
            )}
            {party.phone && (
              <span className="flex items-center gap-1">
                <Phone className="h-3.5 w-3.5 text-slate-400" />
                {party.phone}
              </span>
            )}
            {party.paymentTermsName && (
              <span className="flex items-center gap-1 font-medium text-slate-700 dark:text-slate-300">
                <Clock className="h-3.5 w-3.5 text-slate-400" />
                Terms: {party.paymentTermsName}
              </span>
            )}
            {party.subsidiaryName && (
              <span className="flex items-center gap-1">
                <Building className="h-3.5 w-3.5 text-slate-400" />
                {party.subsidiaryName}
              </span>
            )}
          </div>
        </div>

        {party.holdReason && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-2.5 text-xs text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300">
            <span className="font-semibold">Hold reason:</span> {party.holdReason}
          </div>
        )}
      </div>

      {/* Top 4 KPI Stat Tiles */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {/* Open AR */}
        <Card className="p-4">
          <div className="text-xs font-medium text-slate-500">Total Open Receivables</div>
          <div className="mt-1 text-2xl font-bold text-slate-900 dark:text-slate-100">
            {formatCurrency(aging.totalOpen, party.currency)}
          </div>
          <div className="mt-2 text-xs">
            {aging.totalOverdue > 0 ? (
              <span className="font-semibold text-rose-600 dark:text-rose-400">
                {formatCurrency(aging.totalOverdue, party.currency)} overdue
              </span>
            ) : (
              <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                All accounts current
              </span>
            )}
          </div>
        </Card>

        {/* Days Sales Outstanding */}
        <Card className="p-4">
          <div className="text-xs font-medium text-slate-500">Days Sales Outstanding (DSO)</div>
          <div className="mt-1 text-2xl font-bold text-slate-900 dark:text-slate-100">
            {paymentMetrics.dso} <span className="text-sm font-normal text-slate-500">days</span>
          </div>
          <div className="mt-2 text-xs text-slate-500">
            {paymentMetrics.partyAvgDaysToPay !== null ? (
              <span>Customer avg: {paymentMetrics.partyAvgDaysToPay}d (Org: {paymentMetrics.orgAvgDaysToPay}d)</span>
            ) : (
              <span>Org benchmark: {paymentMetrics.orgAvgDaysToPay}d</span>
            )}
          </div>
        </Card>

        {/* Credit Headroom */}
        <Card className="p-4">
          <div className="text-xs font-medium text-slate-500">Credit Headroom</div>
          <div className="mt-1 text-2xl font-bold text-slate-900 dark:text-slate-100">
            {credit.remainingCredit !== null ? (
              formatCurrency(credit.remainingCredit, party.currency)
            ) : (
              <span className="text-slate-500 font-normal">No limit set</span>
            )}
          </div>
          <div className="mt-2 text-xs text-slate-500">
            {credit.creditLimit !== null ? (
              <span>Limit: {formatCurrency(credit.creditLimit, party.currency)} ({Math.round(credit.creditUtilizationPercent || 0)}% used)</span>
            ) : (
              <span>Unrestricted commercial credit</span>
            )}
          </div>
        </Card>

        {/* Pipeline & Win Rate */}
        <Card className="p-4">
          <div className="text-xs font-medium text-slate-500">Active Pipeline Value</div>
          <div className="mt-1 text-2xl font-bold text-slate-900 dark:text-slate-100">
            {formatCurrency(pipeline.projectedPipeline, party.currency)}
          </div>
          <div className="mt-2 text-xs text-slate-500">
            {pipeline.winRatePercent !== null ? (
              <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                {pipeline.winRatePercent}% win rate ({pipeline.wonOpportunities} won)
              </span>
            ) : (
              <span>{pipeline.openOpportunities} open deals</span>
            )}
          </div>
        </Card>
      </div>

      {/* Grid: AR Aging Breakdown & Credit Telemetry */}
      <div className="grid gap-6 lg:grid-cols-3">
        {/* AR Aging Buckets */}
        <Card className="p-5 lg:col-span-2">
          <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
            A/R Aging Schedule
          </h3>
          <p className="mt-0.5 text-xs text-slate-500">
            Open receivables as-of today classified into aging intervals.
          </p>

          <div className="mt-4 grid grid-cols-5 gap-2 border-t border-slate-100 pt-3 text-center dark:border-slate-800">
            <div className="rounded-lg bg-emerald-50/60 p-2.5 dark:bg-emerald-950/20">
              <div className="text-[11px] font-medium text-slate-500">Current</div>
              <div className="mt-1 text-sm font-bold text-emerald-700 dark:text-emerald-300">
                {formatCurrency(aging.current, party.currency)}
              </div>
            </div>
            <div className="rounded-lg bg-slate-50 p-2.5 dark:bg-slate-900">
              <div className="text-[11px] font-medium text-slate-500">1–30d</div>
              <div className="mt-1 text-sm font-bold text-slate-800 dark:text-slate-200">
                {formatCurrency(aging.days1To30, party.currency)}
              </div>
            </div>
            <div className="rounded-lg bg-amber-50/60 p-2.5 dark:bg-amber-950/20">
              <div className="text-[11px] font-medium text-slate-500">31–60d</div>
              <div className="mt-1 text-sm font-bold text-amber-700 dark:text-amber-300">
                {formatCurrency(aging.days31To60, party.currency)}
              </div>
            </div>
            <div className="rounded-lg bg-orange-50/60 p-2.5 dark:bg-orange-950/20">
              <div className="text-[11px] font-medium text-slate-500">61–90d</div>
              <div className="mt-1 text-sm font-bold text-orange-700 dark:text-orange-300">
                {formatCurrency(aging.days61To90, party.currency)}
              </div>
            </div>
            <div className="rounded-lg bg-rose-50/60 p-2.5 dark:bg-rose-950/20">
              <div className="text-[11px] font-medium text-slate-500">90+ days</div>
              <div className="mt-1 text-sm font-bold text-rose-700 dark:text-rose-300">
                {formatCurrency(aging.days90Plus, party.currency)}
              </div>
            </div>
          </div>
        </Card>

        {/* Credit Breakdown */}
        <Card className="p-5">
          <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
            Credit Commitment
          </h3>
          <p className="mt-0.5 text-xs text-slate-500">
            Receivables plus unbilled sales order commitments.
          </p>

          <div className="mt-4 space-y-2.5 text-xs border-t border-slate-100 pt-3 dark:border-slate-800">
            <div className="flex justify-between">
              <span className="text-slate-500">Credit Limit:</span>
              <span className="font-semibold text-slate-900 dark:text-slate-100">
                {credit.creditLimit !== null ? formatCurrency(credit.creditLimit, party.currency) : 'None'}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Open Invoices (AR):</span>
              <span className="font-medium text-slate-800 dark:text-slate-200">
                {formatCurrency(credit.openArBalance, party.currency)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Unbilled Sales Orders:</span>
              <span className="font-medium text-slate-800 dark:text-slate-200">
                {formatCurrency(credit.unbilledOrdersBalance, party.currency)}
              </span>
            </div>
            <div className="flex justify-between border-t border-slate-200 pt-2 font-bold dark:border-slate-800">
              <span>Available Headroom:</span>
              <span
                className={cn(
                  credit.remainingCredit !== null && credit.remainingCredit <= 0
                    ? 'text-rose-600 dark:text-rose-400'
                    : 'text-emerald-600 dark:text-emerald-400',
                )}
              >
                {credit.remainingCredit !== null ? formatCurrency(credit.remainingCredit, party.currency) : 'Uncapped'}
              </span>
            </div>
          </div>
        </Card>
      </div>

      {/* Grid: Projects (if enabled) & Commercial Stats */}
      {projects.enabled && (
        <Card className="p-5">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
              Active Projects Rollup
            </h3>
            <Badge variant="outline">{projects.activeCount} active / {projects.totalCount} total</Badge>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-4 border-t border-slate-100 pt-3 text-center dark:border-slate-800">
            <div>
              <div className="text-xs text-slate-500">Contract Budget</div>
              <div className="mt-1 text-base font-bold text-slate-900 dark:text-slate-100">
                {formatCurrency(projects.totalContractValue, party.currency)}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500">Billed to Date</div>
              <div className="mt-1 text-base font-bold text-emerald-600 dark:text-emerald-400">
                {formatCurrency(projects.totalBilled, party.currency)}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500">Billed Progress</div>
              <div className="mt-1 text-base font-bold text-slate-900 dark:text-slate-100">
                {projects.totalContractValue > 0
                  ? `${Math.round((projects.totalBilled / projects.totalContractValue) * 100)}%`
                  : '—'}
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* Unified Activity & Document Feed */}
      <Card className="p-5">
        <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
          Customer 360 Interaction Timeline
        </h3>
        <p className="mt-0.5 text-xs text-slate-500">
          Chronological history of CRM activities, quotes, sales orders, invoices, and payments.
        </p>

        <div className="mt-4 divide-y divide-slate-100 border-t border-slate-100 dark:divide-slate-800 dark:border-slate-800">
          {timeline.map((item) => {
            let icon = <FileText className="h-4 w-4 text-blue-500" />
            if (item.type === 'activity') icon = <Clock className="h-4 w-4 text-indigo-500" />
            else if (item.type === 'estimate') icon = <Briefcase className="h-4 w-4 text-amber-500" />
            else if (item.type === 'sales_order') icon = <TrendingUp className="h-4 w-4 text-cyan-500" />
            else if (item.type === 'invoice') icon = <FileText className="h-4 w-4 text-rose-500" />
            else if (item.type === 'payment') icon = <Receipt className="h-4 w-4 text-emerald-500" />

            return (
              <div key={item.id} className="flex items-start justify-between py-3 text-xs">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 rounded-full bg-slate-100 p-1.5 dark:bg-slate-800">
                    {icon}
                  </div>
                  <div>
                    <div className="font-semibold text-slate-900 dark:text-slate-100">
                      {item.title}
                    </div>
                    {item.description && (
                      <p className="mt-0.5 line-clamp-1 text-slate-500">
                        {item.description}
                      </p>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-3 text-right">
                  {item.amount !== undefined && (
                    <span className="font-bold text-slate-900 dark:text-slate-100">
                      {formatCurrency(item.amount, item.currency || party.currency)}
                    </span>
                  )}
                  {item.status && (
                    <Badge variant="secondary" className="text-[10px] uppercase">
                      {item.status.replace('_', ' ')}
                    </Badge>
                  )}
                  <span className="w-20 text-slate-400">
                    {item.timestamp.slice(0, 10)}
                  </span>
                </div>
              </div>
            )
          })}

          {timeline.length === 0 && (
            <div className="py-8 text-center text-xs text-slate-400">
              No recorded activities or transactions for this customer.
            </div>
          )}
        </div>
      </Card>
    </div>
  )
}

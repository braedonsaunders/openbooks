'use client'

import { useState, type ReactNode } from 'react'
import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { ChevronDown } from 'lucide-react'
import { Button, Popover, UrlDrawer } from '@openbooks/ui'
import { AuditTrailPanel } from './audit-trail-panel'

interface TransactionDrawerProps {
  closeHref: string
  recordId: string
  title: ReactNode
  description?: ReactNode
  panelClassName?: string
  primaryAction?: ReactNode
  actions?: ReactNode
  actionsMenuHeader?: ReactNode
  footer?: ReactNode
  children: ReactNode
}

/**
 * The shared shell for every editable business transaction flyout.
 *
 * Record families keep their purpose-built bodies, while the flyout chrome and
 * every record-level control live behind one consistent Actions menu. Keeping
 * this boundary shared prevents bills, credits, orders, payments, journals,
 * and expenses from drifting into separate header interaction patterns.
 */
export function TransactionDrawer({
  closeHref,
  recordId,
  title,
  description,
  panelClassName,
  primaryAction,
  actions,
  actionsMenuHeader,
  footer,
  children,
}: TransactionDrawerProps) {
  const t = useTranslations('common')
  const searchParams = useSearchParams()
  const [actionsOpen, setActionsOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<'details' | 'audit'>('details')
  const hasActions = actions != null || actionsMenuHeader != null
  const requestedReturn = searchParams.get('drawerReturn')
  const nestedReturn = requestedReturn?.startsWith('/') && !requestedReturn.startsWith('//')
    ? requestedReturn
    : null

  return (
    <UrlDrawer
      open
      closeHref={nestedReturn ?? closeHref}
      stacked={nestedReturn != null && searchParams.has('relatedParty')}
      size="2xl"
      panelClassName={panelClassName}
      title={title}
      description={description}
      subtabs={
        <nav className="-mb-px flex gap-1" aria-label={t('auditTrail.ariaLabel')}>
          {(['details', 'audit'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={activeTab === tab}
              onClick={() => setActiveTab(tab)}
              className={`border-b-2 px-3 py-3 text-sm font-medium transition-colors ${
                activeTab === tab
                  ? 'border-teal-600 text-teal-700 dark:border-teal-400 dark:text-teal-300'
                  : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800 dark:text-slate-400 dark:hover:border-slate-700 dark:hover:text-slate-200'
              }`}
            >
              {t(`auditTrail.tabs.${tab}`)}
            </button>
          ))}
        </nav>
      }
      headerActions={primaryAction != null || hasActions ? (
        <div className="flex items-center gap-1.5">
          {primaryAction}
          {hasActions ? (
            <Popover
              open={actionsOpen}
              onOpenChange={setActionsOpen}
              align="end"
              trigger={
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1.5 px-2.5 text-xs"
                  onClick={() => setActionsOpen((open) => !open)}
                  aria-expanded={actionsOpen}
                >
                  {t('labels.actions')}
                  <ChevronDown
                    className={`h-3.5 w-3.5 transition-transform ${actionsOpen ? 'rotate-180' : ''}`}
                    aria-hidden
                  />
                </Button>
              }
              className="w-64 p-1.5"
            >
              {actionsMenuHeader}
              <div className="space-y-0.5 [&_a]:!h-8 [&_a]:w-full [&_a]:!justify-start [&_a]:!rounded [&_a]:!border-0 [&_a]:!bg-transparent [&_a]:!px-2 [&_a]:!text-xs [&_a]:!text-slate-700 [&_a]:!shadow-none [&_a:hover]:!bg-slate-100 dark:[&_a]:!text-slate-200 dark:[&_a:hover]:!bg-slate-800 [&_button]:!h-8 [&_button]:w-full [&_button]:!justify-start [&_button]:!rounded [&_button]:!border-0 [&_button]:!bg-transparent [&_button]:!px-2 [&_button]:!text-xs [&_button]:!text-slate-700 [&_button]:!shadow-none [&_button:hover]:!bg-slate-100 [&_button:disabled]:!text-slate-300 dark:[&_button]:!text-slate-200 dark:[&_button:hover]:!bg-slate-800 dark:[&_button:disabled]:!text-slate-600 [&_button.text-red-600]:!text-red-600 dark:[&_button.text-red-600]:!text-red-400">
                {actions}
              </div>
            </Popover>
          ) : null}
        </div>
      ) : undefined}
      footer={activeTab === 'details' ? footer : undefined}
    >
      {activeTab === 'details' ? children : <AuditTrailPanel table="documents" recordId={recordId} />}
    </UrlDrawer>
  )
}

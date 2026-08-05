'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import { ArrowRight, BriefcaseBusiness, CalendarClock, FileCheck2, FileText, Hash, Layers3, LockKeyhole, ReceiptText, Repeat2 } from 'lucide-react'
import { Badge, Button, Card, CardContent, cn } from '@openbooks/ui'

export function InvoicingSettingsWorkspace({
  subscriptionBillingEnabled,
  activeSubscriptions,
  pausedSubscriptions,
  projectsEnabled,
  activeProjectTypes,
  standardProjectTypes,
  applicationProjectTypes,
}: {
  subscriptionBillingEnabled: boolean
  activeSubscriptions: number
  pausedSubscriptions: number
  projectsEnabled: boolean
  activeProjectTypes: number
  standardProjectTypes: number
  applicationProjectTypes: number
}) {
  return (
    <div className="space-y-7">
      <div>
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Invoicing</h2>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-500 dark:text-slate-400">
          Review the customer-invoice workflows your company offers. All feature gates are managed centrally on the Features page; every enabled workflow produces the same controlled customer invoice.
        </p>
      </div>

      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Available invoice workflows</h3>
          <p className="mt-0.5 text-xs leading-5 text-slate-500 dark:text-slate-400">
            Feature gates live on the Features page. Progress and final are lifecycle stages within project invoicing, not independent gates.
          </p>
        </div>
        <div className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
          <WorkflowRow
            icon={ReceiptText}
            title="Standard invoicing"
            description="Create one-time customer invoices and credits directly or from estimates and sales orders."
            status={<Badge variant="success">Always available</Badge>}
            control={<LockKeyhole size={15} className="text-slate-400" aria-label="Core invoicing cannot be disabled" />}
          />
          <WorkflowRow
            icon={Repeat2}
            title="Subscription billing"
            description="Plans and customer subscriptions generate recurring invoices on a controlled schedule."
            status={
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={subscriptionBillingEnabled ? 'success' : 'secondary'}>{subscriptionBillingEnabled ? 'Enabled' : 'Disabled'}</Badge>
                {activeSubscriptions > 0 || pausedSubscriptions > 0 ? (
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    {activeSubscriptions} active · {pausedSubscriptions} paused
                  </span>
                ) : null}
              </div>
            }
            note="The authoritative Subscription Billing gate lives in Company Settings → Features."
            noteTone="info"
            action={
              <div className="flex flex-wrap gap-2">
                <Button asChild variant="outline" size="sm">
                  <Link href="/admin/setup/features">Manage feature gate</Link>
                </Button>
                {subscriptionBillingEnabled ? (
                  <Button asChild variant="outline" size="sm">
                    <Link href="/collections">Open subscriptions</Link>
                  </Button>
                ) : null}
              </div>
            }
            control={<ArrowRight size={16} className="text-slate-400" aria-hidden />}
          />
          <WorkflowRow
            icon={BriefcaseBusiness}
            title="Project invoicing"
            description="Bill project work using the procedure and economic model assigned by each project type."
            status={<Badge variant={projectsEnabled ? 'success' : 'secondary'}>{projectsEnabled ? 'Enabled' : 'Disabled'}</Badge>}
            note="The authoritative Projects parent gate lives in Company Settings → Features."
            noteTone="info"
            action={
              <div className="flex flex-wrap gap-2">
                <Button asChild variant="outline" size="sm">
                  <Link href="/admin/setup/features">Manage feature gate</Link>
                </Button>
                {projectsEnabled ? (
                  <Button asChild variant="outline" size="sm">
                    <Link href="/admin/setup/project-types">Configure project types</Link>
                  </Button>
                ) : null}
              </div>
            }
            control={<ArrowRight size={16} className="text-slate-400" aria-hidden />}
          />
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Project invoicing policy</h3>
          <p className="mt-0.5 text-xs leading-5 text-slate-500 dark:text-slate-400">
            Project types define how work becomes an invoice. The Projects gate must be on before any procedure can operate.
          </p>
        </div>
        <Card>
          <CardContent className="space-y-5 p-5">
            <div className="grid gap-3 sm:grid-cols-3">
              <Metric label="Configured project types" value={activeProjectTypes} muted={!projectsEnabled} />
              <Metric label="Standard billing request" value={standardProjectTypes} muted={!projectsEnabled} />
              <Metric label="Application for payment" value={applicationProjectTypes} muted={!projectsEnabled} />
            </div>
            {!projectsEnabled ? (
              <p className="text-xs font-medium text-amber-700 dark:text-amber-400">These project billing profiles are preserved but dormant while the Projects parent gate is off.</p>
            ) : null}

            <div className="grid gap-3 md:grid-cols-3">
              <PolicyCard
                icon={<Layers3 size={17} />}
                title="Billing procedure"
                description="A project type selects standard billing requests or an application-for-payment procedure with Schedule of Values, change orders, retainage, and draws."
              />
              <PolicyCard
                icon={<CalendarClock size={17} />}
                title="Progress stage"
                description="An interim invoice stage for approved work to date. It is available only through the project’s configured procedure."
              />
              <PolicyCard
                icon={<FileCheck2 size={17} />}
                title="Final stage"
                description="The closing invoice stage for the remaining approved value. It is not a separate module or parallel billing engine."
              />
            </div>

            <div className="flex flex-wrap gap-2">
              <Button asChild size="sm">
                <Link href={projectsEnabled ? '/admin/setup/project-types' : '/admin/setup/features'}>
                  {projectsEnabled ? 'Configure project types' : 'Enable Projects in Features'}
                </Link>
              </Button>
              {projectsEnabled && applicationProjectTypes > 0 ? (
                <Button asChild variant="outline" size="sm">
                  <Link href="/projects">Open projects</Link>
                </Button>
              ) : null}
            </div>
          </CardContent>
        </Card>
      </section>

      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Invoice controls</h3>
          <p className="mt-0.5 text-xs leading-5 text-slate-500 dark:text-slate-400">Configure the shared terms, legal numbering, and customer-facing presentation used by every workflow.</p>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <ControlLink icon={CalendarClock} title="Payment terms" description="Due dates and early-payment discounts" href="/admin/setup/payment-terms" />
          <ControlLink icon={Hash} title="Number sequences" description="Per-document and legal-entity numbering" href="/admin/setup/number-sequences" />
          <ControlLink icon={FileText} title="Invoice templates" description="Customer-facing PDF layouts and defaults" href="/admin/pdf-templates?recordType=customer_invoice" />
        </div>
      </section>
    </div>
  )
}

function WorkflowRow({
  icon: Icon,
  title,
  description,
  status,
  note,
  noteTone = 'warning',
  action,
  control,
}: {
  icon: typeof ReceiptText
  title: string
  description: string
  status: ReactNode
  note?: string
  noteTone?: 'info' | 'warning'
  action?: ReactNode
  control: ReactNode
}) {
  return (
    <div className="flex items-start gap-4 p-4">
      <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300">
        <Icon size={18} aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="text-sm font-medium text-slate-900 dark:text-slate-100">{title}</h4>
          {status}
        </div>
        <p className="mt-0.5 max-w-3xl text-xs leading-5 text-slate-500 dark:text-slate-400">{description}</p>
        {note ? (
          <p className={cn('mt-1.5 text-xs font-medium', noteTone === 'warning' ? 'text-amber-700 dark:text-amber-400' : 'text-slate-500 dark:text-slate-400')}>{note}</p>
        ) : null}
        {action ? <div className="mt-3">{action}</div> : null}
      </div>
      <div className="shrink-0 pt-1">{control}</div>
    </div>
  )
}

function Metric({ label, value, muted }: { label: string; value: number; muted: boolean }) {
  return (
    <div
      className={cn(
        'rounded-lg border p-3',
        muted ? 'border-slate-200 bg-slate-50 opacity-60 dark:border-slate-800 dark:bg-slate-950' : 'border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900',
      )}
    >
      <div className="text-xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">{value}</div>
      <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{label}</div>
    </div>
  )
}

function PolicyCard({ icon, title, description }: { icon: ReactNode; title: string; description: string }) {
  return (
    <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-950">
      <div className="flex items-center gap-2 text-slate-700 dark:text-slate-300">
        {icon}
        <h4 className="text-xs font-semibold">{title}</h4>
      </div>
      <p className="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">{description}</p>
    </div>
  )
}

function ControlLink({ icon: Icon, title, description, href }: { icon: typeof ReceiptText; title: string; description: string; href: string }) {
  return (
    <Card>
      <CardContent className="flex h-full items-start gap-3 p-4">
        <div className="rounded-lg bg-slate-100 p-2 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
          <Icon size={17} aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-medium text-slate-900 dark:text-slate-100">{title}</h4>
          <p className="mt-0.5 text-xs leading-5 text-slate-500 dark:text-slate-400">{description}</p>
          <Button asChild variant="outline" size="sm" className="mt-3">
            <Link href={href}>Configure</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

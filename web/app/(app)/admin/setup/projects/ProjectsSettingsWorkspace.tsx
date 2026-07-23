'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Briefcase, Calculator, ClipboardList, Gauge, Tags } from 'lucide-react'
import { Badge, Button, Card, CardContent, cn } from '@openbooks/ui'
import { toast } from 'sonner'

type Impact = { labelKey: string; count: number }
type DisableStatus = { blocked: boolean; impacts: Impact[] }

const IMPACT_LABELS: Record<string, (count: number) => string> = {
  projects: (n) => `${n} project${n === 1 ? '' : 's'}`,
  activeProjects: (n) => `${n} active project${n === 1 ? '' : 's'}`,
  openProjectBillingRequests: (n) => `${n} open billing request${n === 1 ? '' : 's'}`,
  openPayApplications: (n) => `${n} open application${n === 1 ? '' : 's'} for payment`,
  outstandingRetainage: () => 'outstanding retainage',
  openFieldTickets: (n) => `${n} open field ticket${n === 1 ? '' : 's'}`,
  openProjectDocuments: (n) => `${n} unposted project document${n === 1 ? '' : 's'}`,
  openProjectTimeEntries: (n) => `${n} unapproved project time entr${n === 1 ? 'y' : 'ies'}`,
  openChangeOrders: (n) => `${n} draft change order${n === 1 ? '' : 's'}`,
  controlCheckUnavailable: () => 'an integrity check that could not be completed',
}

export function ProjectsSettingsWorkspace({
  enabled: initialEnabled,
  typeCount,
  activeTypeCount,
  applicationTypeCount,
  fieldTicketsEnabled: initialFieldTicketsEnabled,
  fieldTicketsDisableStatus,
  disableStatus,
}: {
  enabled: boolean
  typeCount: number
  activeTypeCount: number
  applicationTypeCount: number
  fieldTicketsEnabled: boolean
  fieldTicketsDisableStatus: DisableStatus
  disableStatus: DisableStatus
}) {
  const router = useRouter()
  const [enabled, setEnabled] = useState(initialEnabled)
  const [busy, setBusy] = useState(false)
  const [fieldTicketsEnabled, setFieldTicketsEnabled] = useState(initialFieldTicketsEnabled)
  const impacts = disableStatus.impacts.map((i) => (IMPACT_LABELS[i.labelKey] ?? ((n) => `${n} records`))(i.count)).join(', ')

  async function toggle() {
    if (busy || (enabled && disableStatus.blocked)) return
    const next = !enabled
    if (!next && impacts && !window.confirm(`Disable Projects?\n\nAffected records: ${impacts}. Data and audit history will be preserved.`)) return
    setBusy(true)
    try {
      const res = await fetch('/api/admin/setup/features', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ features: { projects: next } }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error === 'feature-blocked' ? 'Projects cannot be disabled while operational or financial obligations remain open.' : (body.error ?? 'Update failed'))
      }
      setEnabled(next)
      toast.success(next ? 'Projects enabled' : 'Projects disabled')
      router.refresh()
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function toggleFieldTickets() {
    if (busy || !enabled || (fieldTicketsEnabled && fieldTicketsDisableStatus.blocked)) return
    const next = !fieldTicketsEnabled
    setBusy(true)
    try {
      const res = await fetch('/api/admin/setup/features', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ features: { fieldTickets: next } }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Update failed')
      setFieldTicketsEnabled(next)
      toast.success(next ? 'Field Tickets enabled' : 'Field Tickets disabled')
      router.refresh()
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Projects</h2>
        <p className="mt-1 max-w-3xl text-sm text-slate-500 dark:text-slate-400">
          Authoritative company policy for project accounting, job costing, project billing, and applications for payment.
        </p>
      </div>

      <Card>
        <CardContent className="flex items-start gap-4 p-5">
          <div className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-lg', enabled ? 'bg-teal-50 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300' : 'bg-slate-100 text-slate-400 dark:bg-slate-800')}>
            <Briefcase size={20} aria-hidden />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="font-semibold text-slate-900 dark:text-slate-100">Enable Projects</h3>
              <Badge variant={enabled ? 'success' : 'secondary'}>{enabled ? 'Enabled' : 'Disabled'}</Badge>
            </div>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              This parent gate controls every Projects page, API, billing workflow, setup surface, and background operation. Disabling it never deletes project or accounting history.
            </p>
            {enabled && disableStatus.blocked ? (
              <p className="mt-2 text-xs font-medium text-amber-700 dark:text-amber-400">
                Cannot disable while these obligations remain: {impacts}.
              </p>
            ) : null}
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label="Enable Projects"
            disabled={busy || (enabled && disableStatus.blocked)}
            onClick={toggle}
            className={cn(
              'relative mt-1 inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-2',
              enabled ? 'bg-teal-600' : 'bg-slate-200 dark:bg-slate-700',
              busy || (enabled && disableStatus.blocked) ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
            )}
          >
            <span className={cn('inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform', enabled ? 'translate-x-[18px]' : 'translate-x-0.5')} />
          </button>
        </CardContent>
      </Card>

      {enabled ? (
        <>
          <section className="space-y-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Billing models and procedures</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">Project types define the available contract economics and their default billing procedure. Interim and final are invoice stages, not feature gates.</p>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <SettingsCard icon={Tags} title="Project types" detail={`${activeTypeCount} active of ${typeCount}`} href="/admin/setup/project-types" action="Manage billing defaults" />
              <SettingsCard icon={ClipboardList} title="Applications for payment" detail={`${applicationTypeCount} active Schedule of Values billing ${applicationTypeCount === 1 ? 'profile' : 'profiles'}`} href="/construction" action="Open SOV billing" />
            </div>
          </section>
          <section className="space-y-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Project operations</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">Subordinate capabilities can only operate while the Projects parent gate is enabled.</p>
            </div>
            <Card>
              <CardContent className="flex items-start gap-4 p-4">
                <div className="rounded-lg bg-slate-100 p-2 text-slate-600 dark:bg-slate-800 dark:text-slate-300"><ClipboardList size={17} aria-hidden /></div>
                <div className="min-w-0 flex-1">
                  <h4 className="text-sm font-medium text-slate-900 dark:text-slate-100">Field Tickets</h4>
                  <p className="mt-0.5 text-xs leading-5 text-slate-500 dark:text-slate-400">Signed crew time, equipment, and material records attached to projects for controlled T&M billing.</p>
                  {fieldTicketsEnabled && fieldTicketsDisableStatus.blocked ? <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-400">Resolve open field tickets before disabling.</p> : null}
                </div>
                <button type="button" role="switch" aria-checked={fieldTicketsEnabled} aria-label="Enable Field Tickets" disabled={busy || (fieldTicketsEnabled && fieldTicketsDisableStatus.blocked)} onClick={toggleFieldTickets}
                  className={cn('relative mt-1 inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors', fieldTicketsEnabled ? 'bg-teal-600' : 'bg-slate-200 dark:bg-slate-700', busy || (fieldTicketsEnabled && fieldTicketsDisableStatus.blocked) ? 'cursor-not-allowed opacity-60' : 'cursor-pointer')}>
                  <span className={cn('inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform', fieldTicketsEnabled ? 'translate-x-[18px]' : 'translate-x-0.5')} />
                </button>
              </CardContent>
            </Card>
          </section>
          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Costing policy</h3>
            <div className="grid gap-3 md:grid-cols-3">
              <SettingsCard icon={Gauge} title="Overhead" detail="Allocation model and effective-dated rate cards" href="/admin/setup/overhead" action="Configure" />
              <SettingsCard icon={Calculator} title="Labor costing" detail="Wage, burden, posting, and reconciliation" href="/admin/setup/labor-costing" action="Configure" />
              <SettingsCard icon={Tags} title="Labor pricing" detail="Effective-dated bill-out rate cards" href="/admin/setup/labor-pricing" action="Configure" />
            </div>
          </section>
        </>
      ) : (
        <div className="rounded-xl border border-dashed border-slate-300 p-6 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
          Project configuration remains dormant and preserved until the Projects parent gate is enabled.
        </div>
      )}
    </div>
  )
}

function SettingsCard({ icon: Icon, title, detail, href, action }: { icon: typeof Briefcase; title: string; detail: string; href: string; action: string }) {
  return (
    <Card>
      <CardContent className="flex h-full items-start gap-3 p-4">
        <div className="rounded-lg bg-slate-100 p-2 text-slate-600 dark:bg-slate-800 dark:text-slate-300"><Icon size={17} aria-hidden /></div>
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-medium text-slate-900 dark:text-slate-100">{title}</h4>
          <p className="mt-0.5 text-xs leading-5 text-slate-500 dark:text-slate-400">{detail}</p>
          <Button asChild variant="outline" size="sm" className="mt-3"><Link href={href}>{action}</Link></Button>
        </div>
      </CardContent>
    </Card>
  )
}

'use client'

import Link from 'next/link'
import { Briefcase, Calculator, ClipboardList, Gauge, Tags } from 'lucide-react'
import { Badge, Button, Card, CardContent } from '@openbooks/ui'

export function ProjectsSettingsWorkspace({
  enabled,
  typeCount,
  activeTypeCount,
  applicationTypeCount,
  fieldTicketsEnabled,
}: {
  enabled: boolean
  typeCount: number
  activeTypeCount: number
  applicationTypeCount: number
  fieldTicketsEnabled: boolean
}) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Projects</h2>
        <p className="mt-1 max-w-3xl text-sm text-slate-500 dark:text-slate-400">
          Configure project accounting, job costing, project billing, and applications for payment. All feature gates are managed centrally on the Features page.
        </p>
      </div>

      <Card>
        <CardContent className="flex items-start gap-4 p-5">
          <div className={enabled ? 'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300' : 'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-400 dark:bg-slate-800'}>
            <Briefcase size={20} aria-hidden />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="font-semibold text-slate-900 dark:text-slate-100">Projects module</h3>
              <Badge variant={enabled ? 'success' : 'secondary'}>{enabled ? 'Enabled' : 'Disabled'}</Badge>
            </div>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              The Projects parent gate controls every project page, API, billing workflow, setup surface, and background operation. Its authoritative switch is on Company Settings → Features.
            </p>
          </div>
          <Button asChild variant="outline" size="sm"><Link href="/admin/setup/features">Manage feature gates</Link></Button>
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
                </div>
                <Badge variant={fieldTicketsEnabled ? 'success' : 'secondary'}>{fieldTicketsEnabled ? 'Enabled' : 'Disabled'}</Badge>
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

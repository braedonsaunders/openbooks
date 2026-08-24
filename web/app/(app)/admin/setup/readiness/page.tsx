import Link from 'next/link'
import { sql } from 'drizzle-orm'
import { CheckCircle2, CircleAlert, CircleDashed, Sparkles } from 'lucide-react'
import { db } from '@openbooks/engine/src/db.ts'
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@openbooks/ui'
import { requirePermission } from '../../../../../lib/authz'
import { onboardingStatus } from '../../../../../lib/onboarding'

export const dynamic = 'force-dynamic'

type Check = {
  title: string
  description: string
  href: string
  action: string
  state: 'complete' | 'review' | 'waiting'
}

export default async function SetupReadinessPage() {
  const { user } = await requirePermission('admin.setup.manage')
  const result = (await db.execute<Record<string, any>>(sql`
    select o.name, o.legal_name, o.base_currency, o.country, o.settings,
      (select count(*)::int from currencies) as currencies,
      (select count(*)::int from subsidiaries s where s.org_id=o.id and s.parent_id is null) as roots,
      (select count(*)::int from accounts a where a.org_id=o.id and a.is_active and not a.is_summary) as accounts,
      (select count(*)::int from accounting_books b where b.org_id=o.id and b.is_active) as books,
      (select count(*)::int from accounting_periods p where p.org_id=o.id) as periods,
      (select count(*)::int from payment_terms pt where pt.org_id=o.id and pt.is_active) as payment_terms,
      (select count(*)::int from tax_codes tc where tc.org_id=o.id and tc.is_active) as tax_codes,
      (select count(*)::int from accounts a where a.org_id=o.id and a.is_active and a.reconcilable) as bank_accounts,
      (select count(*)::int from journal_entries je where je.org_id=o.id and je.status in ('posted','reversed')) as posted_entries,
      (select count(*)::int from close_runs cr where cr.org_id=o.id and cr.status in ('closed','published')) as completed_closes
    from orgs o where o.id=${user.orgId}
  `))
  const org = result.rows[0]
  const settings = ((org?.settings ?? {}))
  const workspaceProfile = (settings.workspaceProfile ?? {}) as Record<string, unknown>
  const bookStart = workspaceProfile.bookStart === 'migrate' ? 'migrate' : 'fresh'
  const taxPosition = ['registered', 'not_registered', 'unsure'].includes(String(workspaceProfile.taxPosition))
    ? String(workspaceProfile.taxPosition)
    : 'unsure'
  const closeCadence = ['monthly', 'quarterly', 'annual'].includes(String(workspaceProfile.closeCadence))
    ? String(workspaceProfile.closeCadence)
    : 'monthly'
  const closeLabel = closeCadence === 'quarterly' ? 'quarterly' : closeCadence === 'annual' ? 'year-end' : 'monthly'
  const activityLabel = workspaceProfile.monthlyActivity === 'high'
    ? 'more than 1,000 monthly activities'
    : workspaceProfile.monthlyActivity === 'steady'
      ? '100–1,000 monthly activities'
      : 'under 100 monthly activities'
  const control = (settings.controlAccounts ?? {}) as Record<string, unknown>
  const foundationReady = org?.currencies > 0 && org?.roots === 1 && org?.accounts > 0
    && org?.books > 0 && org?.periods > 0 && Boolean(control.ar && control.ap && control.bank)
  const profileReady = onboardingStatus(settings) === 'complete' && Boolean(settings.workspaceProfile)

  const checks: Check[] = [
    {
      title: 'Company and workspace profile',
      description: profileReady
        ? `Industry, team responsibilities, ${activityLabel}, ${closeLabel} close cadence, and feature recommendations have been reviewed.`
        : 'Tell OpenBooks how your company operates so the workspace starts at the right level.',
      href: '/admin/setup/wizard', action: profileReady ? 'Review profile' : 'Run walkthrough',
      state: profileReady ? 'complete' : 'waiting',
    },
    {
      title: 'Accounting foundation',
      description: foundationReady
        ? `${org.accounts} active accounts, a primary book, fiscal periods, control accounts, and one root entity are ready.`
        : 'Finish the chart of accounts, book, periods, root entity, currency, and control-account mapping before posting.',
      href: '/admin/setup/company', action: 'Review foundation', state: foundationReady ? 'complete' : 'waiting',
    },
    {
      title: 'Invoices, bills, and payment terms',
      description: org?.payment_terms > 0
        ? `${org!.payment_terms} active payment term${org!.payment_terms === 1 ? '' : 's'} available. Review numbering and document defaults.`
        : 'Choose at least one payment term so due dates do not have to be calculated by hand.',
      href: '/admin/setup/invoicing', action: 'Review invoicing', state: org?.payment_terms > 0 ? 'complete' : 'review',
    },
    {
      title: 'Tax treatment',
      description: org?.tax_codes > 0
        ? `${org!.tax_codes} active tax code${org!.tax_codes === 1 ? '' : 's'} configured. Confirm registrations and filing obligations.`
        : taxPosition === 'not_registered'
          ? 'You confirmed this company is not currently required to collect sales tax, GST/HST, or VAT. Revisit this before obligations change.'
          : taxPosition === 'registered'
            ? 'You confirmed the company is registered. Add its jurisdiction, registration, tax codes, and filing cadence before issuing live documents.'
            : 'Tax registration is still undecided. Resolve it before issuing live invoices or recording recoverable tax.',
      href: '/admin/setup/tax-setup', action: 'Review tax',
      state: org?.tax_codes > 0 || taxPosition === 'not_registered' ? 'complete' : 'review',
    },
    {
      title: 'Bank and card accounts',
      description: org?.bank_accounts > 0
        ? `${org!.bank_accounts} reconcilable account${org!.bank_accounts === 1 ? '' : 's'} will appear in Banking. Keep only real accounts reconcilable.`
        : 'Mark each real bank or card GL account as reconcilable before importing statements.',
      href: '/admin/setup/accounts', action: 'Review bank accounts', state: org?.bank_accounts > 0 ? 'complete' : 'review',
    },
    {
      title: 'Opening balances and cutover',
      description: bookStart === 'fresh'
        ? org?.posted_entries > 0
          ? `Books began from zero; ${org!.posted_entries} posted entr${org!.posted_entries === 1 ? 'y records' : 'ies record'} live activity rather than a migrated opening balance.`
          : 'You confirmed the books start from zero, so no migration journal is expected.'
        : org?.posted_entries > 0
          ? `${org!.posted_entries} posted entr${org!.posted_entries === 1 ? 'y exists' : 'ies exist'}. Reconcile the opening journal to the source trial balance and open-item detail before declaring cutover complete.`
          : 'You are moving existing books. Enter a balanced opening journal and verify customer, vendor, bank, tax, and retained-earnings detail.',
      href: '/journal',
      action: bookStart === 'fresh' ? 'Review ledger' : org?.posted_entries > 0 ? 'Review journal' : 'Enter opening balances',
      state: bookStart === 'fresh' ? 'complete' : org?.posted_entries > 0 ? 'review' : 'waiting',
    },
    {
      title: `First ${closeLabel} close`,
      description: org?.completed_closes > 0
        ? `${org!.completed_closes} period close${org!.completed_closes === 1 ? '' : 's'} completed with a preserved checklist, sign-off, locks, and close package.`
        : org?.posted_entries > 0
          ? `Live activity exists. Reconcile the period, review financial statements, complete the ${closeLabel} checklist, attest or approve, lock, and publish.`
          : `After live activity begins, OpenBooks will guide the first ${closeLabel} close from reconciliation through locked books and a preserved close package.`,
      href: '/close', action: org?.completed_closes > 0 ? 'Review closes' : 'Open close workspace',
      state: org?.completed_closes > 0 ? 'complete' : org?.posted_entries > 0 ? 'review' : 'waiting',
    },
  ]
  const complete = checks.filter((item) => item.state === 'complete').length
  const hardReady = profileReady && foundationReady

  return (
    <div className="space-y-6">
      <Card className="overflow-hidden">
        <CardHeader className="space-y-5 p-6 sm:p-7">
          <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-start">
            <div className="flex min-w-0 items-start gap-4">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-teal-50 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300">
                <Sparkles size={20} />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-teal-700 dark:text-teal-300">Go-live guide</p>
                <CardTitle className="mt-1 text-xl">Make the first posting boring—in the best way.</CardTitle>
                <CardDescription className="mt-2 max-w-2xl leading-relaxed">
                  OpenBooks has shaped the workspace around your company. This guide verifies the decisions that make invoices, bills, banking, and period close reliable from day one.
                </CardDescription>
              </div>
            </div>
            <Badge variant={hardReady ? 'success' : 'warning'} className="shrink-0 self-start">
              {hardReady ? 'Accounting foundation ready' : 'Foundation needs attention'}
            </Badge>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="font-medium text-slate-700 dark:text-slate-200">Setup progress</span>
              <span className="tabular-nums text-slate-500 dark:text-slate-400">{complete} of {checks.length} areas prepared</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800" role="progressbar" aria-label="Setup progress" aria-valuemin={0} aria-valuemax={checks.length} aria-valuenow={complete}>
              <div className="h-full rounded-full bg-teal-600 transition-[width]" style={{ width: `${Math.round((complete / checks.length) * 100)}%` }} />
            </div>
          </div>
        </CardHeader>
      </Card>

      <div className="space-y-3">
        {checks.map((item, index) => {
          const Icon = item.state === 'complete' ? CheckCircle2 : item.state === 'review' ? CircleAlert : CircleDashed
          return (
            <Card key={item.title} className="overflow-hidden">
              <CardHeader className="pb-3">
                <div className="flex items-start gap-4">
                  <div className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${item.state === 'complete' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950' : item.state === 'review' ? 'bg-amber-100 text-amber-700 dark:bg-amber-950' : 'bg-slate-100 text-slate-500 dark:bg-slate-800'}`}>
                    <Icon size={18} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2"><span className="text-xs font-semibold text-slate-400">{index + 1}</span><CardTitle className="text-base">{item.title}</CardTitle></div>
                    <CardDescription className="mt-1">{item.description}</CardDescription>
                  </div>
                  <Button variant="outline" size="sm" asChild><Link href={(item.href)}>{item.action}</Link></Button>
                </div>
              </CardHeader>
              <CardContent className="sr-only">{item.state}</CardContent>
            </Card>
          )
        })}
      </div>
    </div>
  )
}

'use client'

import { useEffect, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Badge, Button } from '@openbooks/ui'
import Link from 'next/link'
import { DrawerTabStrip } from '../../../components/drawer-tab-strip'
import { PagedTable } from '../../../components/paged-table'
import { SetupDrawer } from '../admin/setup/[entity]/SetupDrawer'
import { PAYROLL_VACATION_TERMS_ENTITY } from '../../../lib/setup/payroll-vacation-terms'
import { PAYROLL_SERVICE_CREDITS_ENTITY } from '../../../lib/setup/payroll-service-credits'
import { EnrollmentDrawer } from '../hrm/benefits/EnrollmentDrawer'
import { EmployeeEntitlementBalances } from './EmployeeEntitlementBalances'
import { readApiErrorMessage } from '../../../lib/api-error'
import { formatDecimal } from '../../../lib/money-format'
import { useLocale } from 'next-intl'

import type { EmployeeBenefitPolicyRow as PolicyRow, EmployeeBenefitsData } from '../../../lib/hrm/employee-benefits-types'

/** Employee policy editors share the Benefits records and native drawer commands. */
export function EmployeeBenefitsPanel({ partyId }: { partyId: string }) {
  const t = useTranslations('hrm.benefitPolicies')
  const programs = useTranslations('hrm.employeeBenefits')
  const common = useTranslations('common')
  const admin = useTranslations('admin.setup')
  const router = useRouter()
  const path = usePathname()
  const search = useSearchParams()
  const locale = useLocale()
  const requestedTab = search.get('benefitsTab')
  const initialTab = requestedTab === 'service' || requestedTab === 'balances' ? requestedTab : 'programs'
  const [tab, setTab] = useState(initialTab)
  const [loadedTab, setLoadedTab] = useState(initialTab)
  if (loadedTab !== initialTab) { setLoadedTab(initialTab); setTab(initialTab) }
  const [data, setData] = useState<EmployeeBenefitsData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [loadedParty, setLoadedParty] = useState(partyId)
  if (loadedParty !== partyId) { setLoadedParty(partyId); setData(null); setError(null); setTab(initialTab) }
  useEffect(() => {
    const controller = new AbortController()
    fetch(`/api/hrm/employee-benefits?employee=${encodeURIComponent(partyId)}`, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error(await readApiErrorMessage(response, common('feedback.loadFailed')))
      return response.json() as Promise<EmployeeBenefitsData>
    }).then(value => { if (!controller.signal.aborted) { setData(value); setError(null) } }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : common('feedback.loadFailed'))
    })
    return () => controller.abort()
  }, [partyId, revision, common])
  const returnParams = new URLSearchParams(search.toString())
  returnParams.delete('benefitPolicyRow'); returnParams.delete('benefitPolicyKind')
  const closeHref = `${path}?${returnParams}`
  function href(kind: string, id: string) {
    const next = new URLSearchParams(returnParams); next.set('benefitPolicyKind', kind); next.set('benefitPolicyRow', id)
    return `${path}?${next}`
  }
  if (error && !data) return <div role="alert" className="space-y-3"><p>{error}</p><Button variant="outline" onClick={() => setRevision(value => value + 1)}>{common('actions.retry')}</Button></div>
  if (!data) return <p>{common('feedback.loading')}</p>
  const kind = search.get('benefitPolicyKind')
  const rowId = search.get('benefitPolicyRow')
  const selected = kind === 'vacation' ? data.vacation.find(row => row.id === rowId) : data.service.find(row => row.id === rowId)
  const enrollment = kind === 'coverage' ? data.enrollments.find(row => row.record.id === rowId) : undefined
  const policyEntity = kind === 'vacation' ? PAYROLL_VACATION_TERMS_ENTITY : PAYROLL_SERVICE_CREDITS_ENTITY
  const open = (section: string, id: string) => router.push(href(section, id), { scroll: false })
  const dates = [{ key: 'effective_from', header: admin('fields.effectiveFrom'), cell: (row: PolicyRow) => row.effective_from }, { key: 'effective_to', header: admin('fields.effectiveTo'), cell: (row: PolicyRow) => row.effective_to ?? '—' }]
  const number = (value: unknown) => value == null ? '—' : formatDecimal(locale, String(value), { maximumFractionDigits: 4 })
  const activeTab = tab === 'service' && !data.payroll || tab === 'balances' && !data.canReadBanks ? 'programs' : tab
  const canCreate = data.canManage && data.payroll && activeTab === 'service'
  return <div className="space-y-4">
    {error ? <div role="alert"><p>{error}</p><Button variant="outline" onClick={() => setRevision(value => value + 1)}>{common('actions.retry')}</Button></div> : null}
    <DrawerTabStrip tabs={[{ key: 'programs', label: programs('programs') }, ...(data.payroll ? [{ key: 'service', label: programs('service') }] : []), ...(data.canReadBanks ? [{ key: 'balances', label: programs('balances') }] : [])]} activeKey={activeTab} onSelect={setTab} ariaLabel={programs('title')} />
    {canCreate ? <Button variant="outline" size="sm" onClick={() => open('service', 'new')}>{programs('newService')}</Button> : null}
    {activeTab === 'programs' ? <PagedTable source="hrm_employee_benefits" rows={data.assignments} rowKey={row => row.id} searchable empty={programs('emptyTitle')} onRowClick={row => {
      if (row.nativeKind === 'enrollment') open('coverage', row.nativeId)
      else if (row.nativeKind === 'vacation_terms') open('vacation', row.nativeId)
      else router.push(row.assignmentHref)
    }} columns={[
      { key: 'program', header: programs('program'), cell: row => <Link href={row.programHref as never} className="font-medium text-teal-700 hover:underline dark:text-teal-300">{row.programName}</Link>, search: row => row.programName },
      { key: 'type', header: programs('type'), cell: row => row.programTypeLabel, search: row => row.programTypeLabel },
      { key: 'effective', header: programs('effective'), cell: row => `${row.effectiveFrom} – ${row.effectiveTo ?? '…'}`, search: row => row.effectiveFrom },
      { key: 'status', header: common('labels.status'), cell: row => <Badge variant={row.status === 'active' ? 'success' : 'outline'}>{row.statusLabel}</Badge>, search: row => row.statusLabel },
    ]} /> : null}
    {activeTab === 'service' ? <PagedTable source="employee_service_credits" rows={data.service} rowKey={row => row.id} empty={t('empty')} onRowClick={row => open('service', row.id)} columns={[
      { key: 'asOf', header: admin('fields.asOfDate'), cell: row => String(row.as_of_date) },
      { key: 'credit', header: t('service'), cell: row => `${number(row.credited_months ?? row.credited_days)} · ${admin(row.convention === 'calendar_months' ? 'serviceCredit.calendarMonths' : 'serviceCredit.actual365')}` }, ...dates,
    ]} /> : null}
    {activeTab === 'balances' && data.canReadBanks ? <div className="space-y-3"><p className="text-sm text-slate-500 dark:text-slate-400">{programs('policyHint')}</p><EmployeeEntitlementBalances partyId={partyId} readOnly={!data.canManage} /></div> : null}
    {enrollment ? <EnrollmentDrawer key={enrollment.record.id} stacked record={enrollment.record} canManage={data.canManage} canChange={enrollment.canChange} closeHref={closeHref} onSaved={() => setRevision(value => value + 1)} /> : null}
    {data.payroll && ['vacation', 'service'].includes(kind ?? '') && (selected || rowId === 'new' && data.canManage) ? <SetupDrawer key={rowId} entity={{ ...policyEntity, readOnly: !data.canManage }} row={selected ?? null} members={[]} refOptions={{ 'worker-employments': data.employments, 'entitlement-plans': data.programs }}
      stacked closeHref={closeHref} initialValues={rowId === 'new' && data.employments.length === 1 ? { employmentId: data.employments[0]!.value } : undefined}
      fixedValues={selected ? { employmentId: selected.employment_id, ...(kind === 'vacation' ? { planId: selected.plan_id } : {}) } : data.employments.length === 1 ? { employmentId: data.employments[0]!.value } : undefined}
      mutationBasePath="/api/hrm/benefit-plan-configuration" onSaved={() => setRevision(value => value + 1)} /> : null}
  </div>
}

'use client'

import { useEffect, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button } from '@openbooks/ui'
import { DrawerTabStrip } from '../../../components/drawer-tab-strip'
import { PagedTable } from '../../../components/paged-table'
import { SetupDrawer } from '../admin/setup/[entity]/SetupDrawer'
import { PAYROLL_VACATION_TERMS_ENTITY } from '../../../lib/setup/payroll-vacation-terms'
import { PAYROLL_SERVICE_CREDITS_ENTITY } from '../../../lib/setup/payroll-service-credits'
import { EnrollmentDrawer, type EnrollmentDrawerRecord } from '../hrm/benefits/EnrollmentDrawer'
import { EmployeeEntitlementBalances } from './EmployeeEntitlementBalances'
import { readApiErrorMessage } from '../../../lib/api-error'
import { formatDecimal } from '../../../lib/money-format'
import { useLocale } from 'next-intl'

type PolicyRow = Record<string, unknown> & { id: string; employment_id: string; effective_from: string; effective_to: string | null }
interface EmployeeBenefitsData {
  employments: { value: string; label: string }[]
  enrollments: { id: string; record: EnrollmentDrawerRecord; canChange: boolean }[]
  vacation: PolicyRow[]
  service: PolicyRow[]
  canManage: boolean
  canReadBanks: boolean
  payroll: boolean
}

/** Employee policy editors share the Benefits records and native drawer commands. */
export function EmployeeBenefitsPanel({ partyId }: { partyId: string }) {
  const t = useTranslations('hrm.benefitPolicies')
  const common = useTranslations('common')
  const admin = useTranslations('admin.setup')
  const router = useRouter()
  const path = usePathname()
  const search = useSearchParams()
  const locale = useLocale()
  const [tab, setTab] = useState('coverage')
  const [data, setData] = useState<EmployeeBenefitsData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
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
  const number = (value: unknown) => value == null ? '—' : formatDecimal(locale, String(value), { maximumFractionDigits: 16 })
  const canCreate = data.canManage && data.payroll && ['vacation', 'service'].includes(tab)
  return <div className="space-y-4">
    {error ? <div role="alert"><p>{error}</p><Button variant="outline" onClick={() => setRevision(value => value + 1)}>{common('actions.retry')}</Button></div> : null}
    <DrawerTabStrip tabs={[{ key: 'coverage', label: t('coverage') }, ...(data.payroll ? [{ key: 'vacation', label: t('vacation') }, { key: 'service', label: t('service') }] : []), ...(data.canReadBanks ? [{ key: 'balances', label: t('balances') }] : [])]} activeKey={tab} onSelect={setTab} ariaLabel={t('title')} />
    {canCreate ? <Button variant="outline" size="sm" onClick={() => open(tab, 'new')}>{admin('new')}</Button> : null}
    {tab === 'coverage' ? <PagedTable source="employee_benefit_enrollments" rows={data.enrollments} rowKey={row => row.id} searchable empty={t('empty')} onRowClick={row => open('coverage', row.record.id)} columns={[
      { key: 'plan', header: t('coverage'), cell: row => row.record.planName, search: row => row.record.planName },
      { key: 'from', header: admin('fields.effectiveFrom'), cell: row => row.record.effectiveFrom },
      { key: 'status', header: common('labels.status'), cell: row => row.record.statusLabel },
    ]} /> : null}
    {tab === 'vacation' ? <PagedTable source="employee_vacation_terms" rows={data.vacation} rowKey={row => row.id} empty={t('empty')} onRowClick={row => open('vacation', row.id)} columns={[
      { key: 'method', header: admin('vacationTerms.method'), cell: row => admin(`vacationTerms.${row.method === 'accrue' ? 'accrue' : row.method === 'pay_each_period' ? 'payEachPeriod' : 'paidLeave'}`) },
      { key: 'percent', header: admin('fields.percentFloor'), cell: row => number(row.percent_floor) },
      { key: 'days', header: admin('fields.annualDaysFloor'), cell: row => number(row.annual_days_floor) }, ...dates,
    ]} /> : null}
    {tab === 'service' ? <PagedTable source="employee_service_credits" rows={data.service} rowKey={row => row.id} empty={t('empty')} onRowClick={row => open('service', row.id)} columns={[
      { key: 'asOf', header: admin('fields.asOfDate'), cell: row => String(row.as_of_date) },
      { key: 'credit', header: t('service'), cell: row => `${number(row.credited_months ?? row.credited_days)} · ${admin(row.convention === 'calendar_months' ? 'serviceCredit.calendarMonths' : 'serviceCredit.actual365')}` }, ...dates,
    ]} /> : null}
    {tab === 'balances' && data.canReadBanks ? <EmployeeEntitlementBalances partyId={partyId} readOnly={!data.canManage} /> : null}
    {enrollment ? <EnrollmentDrawer key={enrollment.record.id} stacked record={enrollment.record} canManage={data.canManage} canChange={enrollment.canChange} closeHref={closeHref} onSaved={() => setRevision(value => value + 1)} /> : null}
    {['vacation', 'service'].includes(kind ?? '') && (selected || rowId === 'new' && data.canManage) ? <SetupDrawer key={rowId} entity={{ ...policyEntity, readOnly: !data.canManage }} row={selected ?? null} members={[]} refOptions={{ 'worker-employments': data.employments }}
      stacked closeHref={closeHref} initialValues={rowId === 'new' && data.employments.length === 1 ? { employmentId: data.employments[0]!.value } : undefined}
      fixedValues={selected ? { employmentId: selected.employment_id } : data.employments.length === 1 ? { employmentId: data.employments[0]!.value } : undefined}
      mutationBasePath="/api/hrm/benefit-plan-configuration" onSaved={() => setRevision(value => value + 1)} /> : null}
  </div>
}

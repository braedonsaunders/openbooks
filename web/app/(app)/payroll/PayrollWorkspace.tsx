'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { AlertTriangle, Plus } from 'lucide-react'
import {
  Badge,
  Button,
  Drawer,
  Input,
  Label,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  cn,
} from '@openbooks/ui'
import { useMoney } from '../../../components/money-provider'

export interface RunRow {
  document_id: string
  document_number: string
  document_status: string
  schedule_name: string | null
  period_start: string
  period_end: string
  pay_date: string
  run_status: 'draft' | 'calculated' | 'committed'
  gross_total: string
  net_total: string
  employee_count: number
}

export interface ScheduleOption {
  id: string
  name: string
  frequency: string
}

export interface ProfileRow {
  id: string
  employee_party_id: string
  employee_name: string
  pay_schedule_id: string
  schedule_name: string | null
  province: string
  pay_basis: 'hourly' | 'salary'
  federal_claim_code: number | null
  federal_claim_amount: string | null
  provincial_claim_code: number | null
  provincial_claim_amount: string | null
  additional_tax_per_period: string | null
  cpp_exempt: boolean
  ei_exempt: boolean
  tax_exempt: boolean
  vacation_percent: string | null
  vacation_method: 'accrue' | 'pay_each_period'
  is_active: boolean
}

const PROVINCES = ['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT', 'ZZ'] as const

/** Display status: the document's posted state trumps the run lifecycle. */
export function runDisplayStatus(run: Pick<RunRow, 'document_status' | 'run_status'>): string {
  if (run.document_status === 'posted') return 'posted'
  if (run.document_status === 'void') return 'void'
  return run.run_status
}

export function RunStatusBadge({ status }: { status: string }) {
  const t = useTranslations('payroll')
  const variant =
    status === 'posted' ? 'success' : status === 'committed' ? 'default' : status === 'calculated' ? 'warning' : status === 'void' ? 'destructive' : 'secondary'
  return <Badge variant={variant}>{t(`status.${status}`)}</Badge>
}

/**
 * Payroll workspace body — pay runs + (for payroll.manage) the employee
 * payroll-profile roster with its editor drawer, plus the setup checklist
 * card while any control account is unconfigured.
 */
export function PayrollWorkspace(props: {
  runs: RunRow[]
  schedules: ScheduleOption[]
  profiles: ProfileRow[]
  employees: { id: string; name: string }[]
  profileCount: number
  missingSettings: string[]
  canRun: boolean
  canManage: boolean
}) {
  const t = useTranslations('payroll')
  const router = useRouter()
  const { money } = useMoney()
  const [view, setView] = useState<'runs' | 'employees'>('runs')
  const [busy, setBusy] = useState(false)
  const [scheduleId, setScheduleId] = useState(props.schedules[0]?.id ?? '')
  const [editing, setEditing] = useState<ProfileRow | null>(null)
  const [creatingFor, setCreatingFor] = useState('')

  async function createRun() {
    if (!scheduleId) return
    setBusy(true)
    try {
      const res = await fetch('/api/payroll/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payScheduleId: scheduleId }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? 'failed')
      router.push(`/payroll/runs/${j.documentId}`)
    } catch (e) {
      toast.error((e as Error).message)
      setBusy(false)
    }
  }

  const views = props.canManage ? (['runs', 'employees'] as const) : (['runs'] as const)
  const withoutProfile = props.employees.filter(
    (employee) => !props.profiles.some((profile) => profile.employee_party_id === employee.id),
  )

  return (
    <div className="space-y-4">
      {props.canManage && props.missingSettings.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-200/80 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-300">
          <AlertTriangle size={16} aria-hidden />
          <span className="flex-1">
            {t('checklist.incomplete', { count: props.missingSettings.length })}{' '}
            {props.missingSettings.map((key) => t(`settingsPage.fields.${key}`)).join(', ')}
          </span>
          <Button asChild size="sm" variant="outline">
            <Link href="/admin/setup/payroll">{t('checklist.openSettings')}</Link>
          </Button>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 border-b border-slate-200 dark:border-slate-800">
          {views.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setView(item)}
              className={cn(
                '-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium',
                view === item
                  ? 'border-teal-600 text-teal-700 dark:text-teal-300'
                  : 'border-transparent text-slate-500 hover:text-slate-900 dark:hover:text-slate-100',
              )}
            >
              {item === 'runs' ? t('tabs.runs') : t('tabs.employees', { count: props.profileCount })}
            </button>
          ))}
        </div>
        {props.canManage && (
          <div className="flex items-center gap-2 text-xs">
            <Link href="/admin/setup/pay-schedules" className="font-medium text-teal-700 hover:underline dark:text-teal-300">
              {t('links.paySchedules')}
            </Link>
            <span className="text-slate-300 dark:text-slate-700">·</span>
            <Link href="/admin/setup/pay-components" className="font-medium text-teal-700 hover:underline dark:text-teal-300">
              {t('links.payComponents')}
            </Link>
          </div>
        )}
      </div>

      {view === 'runs' && (
        <>
          {props.canRun && (
            <div className="flex flex-wrap items-end gap-2">
              <div>
                <Label htmlFor="pr-schedule">{t('newRun.schedule')}</Label>
                <Select id="pr-schedule" value={scheduleId} onChange={(e) => setScheduleId(e.target.value)}>
                  {props.schedules.length === 0 && <option value="">{t('newRun.noSchedules')}</option>}
                  {props.schedules.map((schedule) => (
                    <option key={schedule.id} value={schedule.id}>
                      {schedule.name}
                    </option>
                  ))}
                </Select>
              </div>
              <Button onClick={createRun} disabled={busy || !scheduleId}>
                <Plus size={14} aria-hidden /> {t('newRun.create')}
              </Button>
            </div>
          )}
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('columns.number')}</TableHead>
                  <TableHead>{t('columns.schedule')}</TableHead>
                  <TableHead>{t('columns.period')}</TableHead>
                  <TableHead>{t('columns.payDate')}</TableHead>
                  <TableHead>{t('columns.status')}</TableHead>
                  <TableHead className="text-right">{t('columns.gross')}</TableHead>
                  <TableHead className="text-right">{t('columns.net')}</TableHead>
                  <TableHead className="text-right">{t('columns.employees')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {props.runs.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="text-slate-500 dark:text-slate-400">
                      {t('empty.runs')}
                    </TableCell>
                  </TableRow>
                )}
                {props.runs.map((run) => (
                  <TableRow key={run.document_id}>
                    <TableCell>
                      <Link
                        href={`/payroll/runs/${run.document_id}`}
                        className="font-medium text-teal-700 hover:underline dark:text-teal-300"
                      >
                        {run.document_number}
                      </Link>
                    </TableCell>
                    <TableCell>{run.schedule_name ?? '—'}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {run.period_start} – {run.period_end}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{run.pay_date}</TableCell>
                    <TableCell>
                      <RunStatusBadge status={runDisplayStatus(run)} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{money(run.gross_total)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(run.net_total)}</TableCell>
                    <TableCell className="text-right tabular-nums">{run.employee_count}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}

      {view === 'employees' && props.canManage && (
        <>
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <Label htmlFor="pr-add-employee">{t('profiles.addEmployee')}</Label>
              <Select id="pr-add-employee" value={creatingFor} onChange={(e) => setCreatingFor(e.target.value)}>
                <option value="">—</option>
                {withoutProfile.map((employee) => (
                  <option key={employee.id} value={employee.id}>
                    {employee.name}
                  </option>
                ))}
              </Select>
            </div>
            <Button
              variant="outline"
              disabled={!creatingFor}
              onClick={() => {
                const employee = withoutProfile.find((candidate) => candidate.id === creatingFor)
                if (!employee) return
                setEditing({
                  id: '',
                  employee_party_id: employee.id,
                  employee_name: employee.name,
                  pay_schedule_id: props.schedules[0]?.id ?? '',
                  schedule_name: null,
                  province: 'ON',
                  pay_basis: 'hourly',
                  federal_claim_code: 1,
                  federal_claim_amount: null,
                  provincial_claim_code: 1,
                  provincial_claim_amount: null,
                  additional_tax_per_period: null,
                  cpp_exempt: false,
                  ei_exempt: false,
                  tax_exempt: false,
                  vacation_percent: null,
                  vacation_method: 'accrue',
                  is_active: true,
                })
              }}
            >
              <Plus size={14} aria-hidden /> {t('profiles.new')}
            </Button>
          </div>
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('profiles.columns.employee')}</TableHead>
                  <TableHead>{t('profiles.columns.schedule')}</TableHead>
                  <TableHead>{t('profiles.columns.province')}</TableHead>
                  <TableHead>{t('profiles.columns.basis')}</TableHead>
                  <TableHead>{t('profiles.columns.claims')}</TableHead>
                  <TableHead>{t('profiles.columns.vacation')}</TableHead>
                  <TableHead>{t('profiles.columns.status')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {props.profiles.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="text-slate-500 dark:text-slate-400">
                      {t('empty.profiles')}
                    </TableCell>
                  </TableRow>
                )}
                {props.profiles.map((profile) => (
                  <TableRow key={profile.id} className="cursor-pointer" onClick={() => setEditing(profile)}>
                    <TableCell className="font-medium">{profile.employee_name}</TableCell>
                    <TableCell>{profile.schedule_name ?? '—'}</TableCell>
                    <TableCell>{profile.province}</TableCell>
                    <TableCell>{t(`profiles.basis.${profile.pay_basis}`)}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {profile.federal_claim_amount ?? profile.federal_claim_code ?? '—'} /{' '}
                      {profile.provincial_claim_amount ?? profile.provincial_claim_code ?? '—'}
                    </TableCell>
                    <TableCell>
                      {profile.vacation_percent
                        ? `${profile.vacation_percent}% · ${t(`profiles.vacation.${profile.vacation_method}`)}`
                        : '—'}
                    </TableCell>
                    <TableCell>
                      <Badge variant={profile.is_active ? 'success' : 'secondary'}>
                        {profile.is_active ? t('profiles.active') : t('profiles.inactive')}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}

      {editing && (
        <ProfileEditor
          profile={editing}
          schedules={props.schedules}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            setCreatingFor('')
            router.refresh()
          }}
        />
      )}
    </div>
  )
}

function ProfileEditor(props: {
  profile: ProfileRow
  schedules: ScheduleOption[]
  onClose: () => void
  onSaved: () => void
}) {
  const t = useTranslations('payroll.profiles')
  const p = props.profile
  const [busy, setBusy] = useState(false)
  const [payScheduleId, setPayScheduleId] = useState(p.pay_schedule_id)
  const [province, setProvince] = useState(p.province)
  const [payBasis, setPayBasis] = useState<'hourly' | 'salary'>(p.pay_basis)
  const [federalClaimCode, setFederalClaimCode] = useState(p.federal_claim_code == null ? '' : String(p.federal_claim_code))
  const [federalClaimAmount, setFederalClaimAmount] = useState(p.federal_claim_amount ?? '')
  const [provincialClaimCode, setProvincialClaimCode] = useState(p.provincial_claim_code == null ? '' : String(p.provincial_claim_code))
  const [provincialClaimAmount, setProvincialClaimAmount] = useState(p.provincial_claim_amount ?? '')
  const [additionalTax, setAdditionalTax] = useState(p.additional_tax_per_period ?? '')
  const [cppExempt, setCppExempt] = useState(p.cpp_exempt)
  const [eiExempt, setEiExempt] = useState(p.ei_exempt)
  const [taxExempt, setTaxExempt] = useState(p.tax_exempt)
  const [vacationPercent, setVacationPercent] = useState(p.vacation_percent ?? '')
  const [vacationMethod, setVacationMethod] = useState<'accrue' | 'pay_each_period'>(p.vacation_method)
  const [isActive, setIsActive] = useState(p.is_active)

  async function save() {
    setBusy(true)
    try {
      const res = await fetch('/api/payroll/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          employeePartyId: p.employee_party_id,
          payScheduleId,
          province,
          payBasis,
          federalClaimCode: federalClaimCode === '' ? null : Number(federalClaimCode),
          federalClaimAmount: federalClaimAmount || null,
          provincialClaimCode: provincialClaimCode === '' ? null : Number(provincialClaimCode),
          provincialClaimAmount: provincialClaimAmount || null,
          additionalTaxPerPeriod: additionalTax || null,
          cppExempt,
          eiExempt,
          taxExempt,
          vacationPercent: vacationPercent || null,
          vacationMethod,
          isActive,
        }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? 'failed')
      toast.success(t('saved'))
      props.onSaved()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const claimCodes = ['', ...Array.from({ length: 11 }, (_, i) => String(i))]

  return (
    <Drawer
      open
      onClose={props.onClose}
      title={p.employee_name}
      description={t('editorDescription')}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={props.onClose} disabled={busy}>
            {t('cancel')}
          </Button>
          <Button onClick={save} disabled={busy || !payScheduleId}>
            {t('save')}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="pp-schedule">{t('fields.schedule')}</Label>
            <Select id="pp-schedule" value={payScheduleId} onChange={(e) => setPayScheduleId(e.target.value)}>
              <option value="">—</option>
              {props.schedules.map((schedule) => (
                <option key={schedule.id} value={schedule.id}>
                  {schedule.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="pp-province">{t('fields.province')}</Label>
            <Select id="pp-province" value={province} onChange={(e) => setProvince(e.target.value)}>
              {PROVINCES.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="pp-basis">{t('fields.payBasis')}</Label>
            <Select id="pp-basis" value={payBasis} onChange={(e) => setPayBasis(e.target.value as 'hourly' | 'salary')}>
              <option value="hourly">{t('basis.hourly')}</option>
              <option value="salary">{t('basis.salary')}</option>
            </Select>
          </div>
          <div>
            <Label htmlFor="pp-additional">{t('fields.additionalTax')}</Label>
            <Input
              id="pp-additional"
              inputMode="decimal"
              value={additionalTax}
              onChange={(e) => setAdditionalTax(e.target.value)}
              placeholder="0.00"
            />
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="pp-fed-code">{t('fields.federalClaimCode')}</Label>
            <Select id="pp-fed-code" value={federalClaimCode} onChange={(e) => setFederalClaimCode(e.target.value)}>
              {claimCodes.map((code) => (
                <option key={code} value={code}>
                  {code === '' ? '—' : code}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="pp-fed-amount">{t('fields.federalClaimAmount')}</Label>
            <Input
              id="pp-fed-amount"
              inputMode="decimal"
              value={federalClaimAmount}
              onChange={(e) => setFederalClaimAmount(e.target.value)}
              placeholder={t('fields.claimAmountHint')}
            />
          </div>
          <div>
            <Label htmlFor="pp-prov-code">{t('fields.provincialClaimCode')}</Label>
            <Select id="pp-prov-code" value={provincialClaimCode} onChange={(e) => setProvincialClaimCode(e.target.value)}>
              {claimCodes.map((code) => (
                <option key={code} value={code}>
                  {code === '' ? '—' : code}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="pp-prov-amount">{t('fields.provincialClaimAmount')}</Label>
            <Input
              id="pp-prov-amount"
              inputMode="decimal"
              value={provincialClaimAmount}
              onChange={(e) => setProvincialClaimAmount(e.target.value)}
              placeholder={t('fields.claimAmountHint')}
            />
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="pp-vac-pct">{t('fields.vacationPercent')}</Label>
            <Input
              id="pp-vac-pct"
              inputMode="decimal"
              value={vacationPercent}
              onChange={(e) => setVacationPercent(e.target.value)}
              placeholder="4.00"
            />
          </div>
          <div>
            <Label htmlFor="pp-vac-method">{t('fields.vacationMethod')}</Label>
            <Select
              id="pp-vac-method"
              value={vacationMethod}
              onChange={(e) => setVacationMethod(e.target.value as 'accrue' | 'pay_each_period')}
            >
              <option value="accrue">{t('vacation.accrue')}</option>
              <option value="pay_each_period">{t('vacation.pay_each_period')}</option>
            </Select>
          </div>
        </div>

        <div className="space-y-2">
          {(
            [
              ['pp-cpp-exempt', t('fields.cppExempt'), cppExempt, setCppExempt],
              ['pp-ei-exempt', t('fields.eiExempt'), eiExempt, setEiExempt],
              ['pp-tax-exempt', t('fields.taxExempt'), taxExempt, setTaxExempt],
              ['pp-active', t('fields.isActive'), isActive, setIsActive],
            ] as const
          ).map(([id, label, checked, set]) => (
            <label key={id} htmlFor={id} className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
              <input
                id={id}
                type="checkbox"
                checked={checked}
                onChange={(e) => set(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500 dark:border-slate-700"
              />
              {label}
            </label>
          ))}
        </div>
      </div>
    </Drawer>
  )
}

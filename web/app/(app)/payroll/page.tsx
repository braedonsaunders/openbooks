import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@openbooks/ui'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { payrollSettings } from '@openbooks/engine/src/payroll-run.ts'
import { ListPageLayout } from '../../../components/page-layout'
import { requirePermission, can } from '../../../lib/authz'
import { requireFeatureEnabled } from '../../../lib/feature-gates'
import { PayrollWorkspace, type ProfileRow, type RunRow, type ScheduleOption } from './PayrollWorkspace'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('payroll')
  return { title: t('title') }
}

/** Control accounts the commit projection cannot post without. */
const REQUIRED_SETTING_KEYS = [
  'wageExpenseAccountId',
  'netPayAccountId',
  'cppPayableAccountId',
  'eiPayableAccountId',
  'taxPayableAccountId',
  'vacationPayableAccountId',
] as const

/**
 * Payroll workspace — pay runs (create → calculate → commit → post), the
 * employee payroll-profile roster, and the setup checklist. Stub amounts are
 * wage data: the whole page sits behind payroll.read, and the profile editor
 * (TD1 facts) additionally behind payroll.manage.
 */
export default async function PayrollPage() {
  const authz = await requirePermission('payroll.read')
  const orgId = authz.user.orgId
  await requireFeatureEnabled(orgId, 'payroll')
  const canRun = can(authz, 'payroll.run')
  const canManage = can(authz, 'payroll.manage')
  const t = await getTranslations('payroll')

  const [runsRes, schedulesRes, settings, profilesRes, employeesRes] = await Promise.all([
    db.execute(sql`
      select r.document_id, d.document_number, d.status as document_status,
             s.name as schedule_name,
             r.period_start::text as period_start, r.period_end::text as period_end,
             r.pay_date::text as pay_date, r.run_status,
             r.gross_total, r.net_total, r.employee_count
        from pay_runs r
        join documents d on d.id = r.document_id
        left join pay_schedules s on s.id = r.pay_schedule_id
       where r.org_id = ${orgId}
       order by r.pay_date desc, d.document_number desc
       limit 200`),
    db.execute(sql`
      select id, name, frequency from pay_schedules
       where org_id = ${orgId} and is_active order by name`),
    payrollSettings(orgId),
    canManage
      ? db.execute(sql`
          select prof.id, prof.employee_party_id, p.display_name as employee_name,
                 prof.pay_schedule_id, s.name as schedule_name, prof.province, prof.pay_basis,
                 prof.federal_claim_code, prof.federal_claim_amount,
                 prof.provincial_claim_code, prof.provincial_claim_amount,
                 prof.additional_tax_per_period, prof.cpp_exempt, prof.ei_exempt, prof.tax_exempt,
                 prof.vacation_percent, prof.vacation_method, prof.is_active
            from employee_payroll_profiles prof
            join parties p on p.id = prof.employee_party_id and p.org_id = prof.org_id
            left join pay_schedules s on s.id = prof.pay_schedule_id
           where prof.org_id = ${orgId}
           order by p.display_name`)
      : Promise.resolve({ rows: [] }),
    canManage
      ? db.execute(sql`
          select p.id, p.display_name as name from parties p
           join employee_roles er on er.party_id = p.id and er.org_id = p.org_id and er.is_active
           where p.org_id = ${orgId} and p.is_active
           order by p.display_name`)
      : Promise.resolve({ rows: [] }),
  ])

  const profileCount = canManage
    ? (profilesRes as unknown as { rows: unknown[] }).rows.length
    : Number(
        (
          (await db.execute(sql`
            select count(*)::int as n from employee_payroll_profiles
             where org_id = ${orgId} and is_active`)) as unknown as { rows: { n: number }[] }
        ).rows[0]?.n ?? 0,
      )
  const missingSettings = REQUIRED_SETTING_KEYS.filter((key) => !settings[key])

  return (
    <ListPageLayout header={<PageHeader title={t('title')} description={t('description')} />}>
      <PayrollWorkspace
        runs={(runsRes as unknown as { rows: RunRow[] }).rows}
        schedules={(schedulesRes as unknown as { rows: ScheduleOption[] }).rows}
        profiles={(profilesRes as unknown as { rows: ProfileRow[] }).rows}
        employees={(employeesRes as unknown as { rows: { id: string; name: string }[] }).rows}
        profileCount={profileCount}
        missingSettings={missingSettings}
        canRun={canRun}
        canManage={canManage}
      />
    </ListPageLayout>
  )
}

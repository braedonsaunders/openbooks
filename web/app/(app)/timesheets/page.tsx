import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { EntityListView } from '../../../components/entity-list-view'
import { can, requirePermission } from '../../../lib/authz'
import { requireFeatureEnabled } from '../../../lib/feature-gates'
import { currentWeekStart, userEmployeeId } from '../../api/timesheets/_lib'

export const dynamic = 'force-dynamic'

export default async function Timesheets({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const t = await getTranslations('timesheets')

  const authz = await requirePermission('time.read')
  await requireFeatureEnabled(authz.user.orgId, 'timeTracking')
  const canManage = can(authz, 'time.manage')
  const orgId = authz.user.orgId

  const sp = await searchParams
  // Employee filter — the same active-employee set the editor uses.
  const employees = (await db.execute(sql`
    select p.id, p.display_name as name
      from parties p
     where p.org_id = ${orgId} and p.is_active
       and exists (select 1 from employee_roles r where r.party_id = p.id and r.org_id = ${orgId} and r.is_active)
     order by p.display_name`)) as unknown as { rows: { id: string; name: string | null }[] }

  // "New timesheet" targets the current user's linked employee (or the first
  // active employee as a fallback picker seed) and the current week.
  const myEmployee = canManage ? await userEmployeeId(orgId, authz.user.id) : null
  const newTarget = myEmployee ?? employees.rows[0]?.id ?? null
  const newHref = newTarget
    ? (`/timesheets/entry?employee=${newTarget}&week=${currentWeekStart()}` as const)
    : ('/timesheets/entry' as const)

  const NewButton = canManage ? (
    <Link
      href={newHref}
      className="inline-flex h-8 items-center gap-2 rounded-md bg-teal-700 px-3 text-sm font-medium text-white shadow-sm hover:bg-teal-800"
    >
      {t('list.newButton')}
    </Link>
  ) : undefined

  return (
    <ListPageLayout
      header={<PageHeader title={t('list.title')} description={t('list.description')} actions={NewButton} />}
    >
      <EntityListView
        recordType="timesheet_week"
        orgId={orgId}
        userId={authz.user.id}
        canManage={can(authz, 'admin.customization.manage')}
        sp={sp}
        emptyAction={NewButton}
      />
    </ListPageLayout>
  )
}

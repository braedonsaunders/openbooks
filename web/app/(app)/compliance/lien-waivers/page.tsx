import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import {
  Badge,
  EmptyState,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { ModuleHomeTabs } from '../../../../components/module-home/ui'
import { can, requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import {
  complianceSubsidiaryFilter,
  loadLienWaivers,
  requireLienWaiverFeature,
  type LienWaiverRow
} from '../../../../lib/compliance'
import { pickString } from '../../../../lib/list-params'
import { getMoneyFormatter } from '@/lib/money-server'
import { complianceTabs } from '../tabs'
import { LienWaiverDrawer } from './LienWaiverDrawer'
import { LienWaiverToolbar } from './LienWaiverToolbar'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('compliance')
  return { title: t('lienWaivers.title') }
}

const STATUS_TONE: Record<string, 'success' | 'warning' | 'destructive' | 'secondary' | 'outline'> = {
  signed: 'success',
  received: 'warning',
  requested: 'warning',
  draft: 'outline',
  rejected: 'destructive',
  void: 'secondary'
}

/**
 * Lien waivers received from subcontractors and issued to owners.
 *
 * The list leads with THROUGH-DATE and AMOUNT because those two fields are what
 * the payment control reads — everything else on the row is context. A waiver
 * that reads "signed" here is a waiver that will release a blocked bill.
 */
export default async function LienWaiversPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('compliance.read')
  await requireFeatureEnabled(authz.user.orgId, 'subcontractorCompliance')
  const orgId = authz.user.orgId
  await requireLienWaiverFeature(orgId)
  const t = await getTranslations('compliance')
  const { money } = await getMoneyFormatter()
  const sp = await searchParams
  const direction = pickString(sp.direction)
  const status = pickString(sp.status) ?? null
  const openId = pickString(sp.waiver) ?? null

  const [waivers, projects, vendors, tabs] = await Promise.all([
    loadLienWaivers({
      orgId,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      direction: direction === 'issued' ? 'issued' : direction === 'received' ? 'received' : null,
      status
    }),
    db.execute<{ id: string; label: string }>(sql`
      select id, coalesce(code || ' · ' || name, name) as label from projects
       where org_id = ${orgId} and is_active
         ${complianceSubsidiaryFilter(sql`subsidiary_id`, authz.allowedSubsidiaryIds)}
       order by code nulls last, name limit 500`),
    db.execute<{ id: string; label: string; defaultType: string }>(sql`
      select p.id, p.display_name as label,
             coalesce(cls.default_lien_waiver_type, '') as "defaultType"
       from parties p
       join vendor_roles vr on vr.party_id = p.id and vr.org_id = p.org_id and vr.is_active
       left join compliance_classes cls on cls.id = vr.compliance_class_id and cls.org_id = p.org_id
       where p.org_id = ${orgId} and p.is_active
         ${complianceSubsidiaryFilter(sql`p.subsidiary_id`, authz.allowedSubsidiaryIds, { orgWideNull: true })}
       order by p.display_name limit 2000`),
    complianceTabs('/compliance/lien-waivers', { projectsEnabled: true })
  ])

  const open: LienWaiverRow | null = openId ? (waivers.find((w) => w.id === openId) ?? null) : null
  // Open bills the vendor could release, so a waiver's amount comes from the
  // money it is exchanged for rather than from retyping.
  const openBills = open
    ? (
        await db.execute<{
          id: string
          label: string
          amount: string
          currency: string
        }>(sql`
        select id, document_number as label, coalesce(open_balance, total) as amount, currency
          from documents
         where org_id = ${orgId} and party_id = ${open.partyId} and project_id = ${open.projectId}
           and kind in ('vendor_bill', 'expense_report') and status = 'posted'
           ${complianceSubsidiaryFilter(sql`subsidiary_id`, authz.allowedSubsidiaryIds)}
         order by document_date desc limit 50`)
      ).rows
    : []

  const query = new URLSearchParams({
    ...(direction ? { direction } : {}),
    ...(status ? { status } : {})
  })

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader title={t('lienWaivers.title')} description={t('lienWaivers.description')} />
          <ModuleHomeTabs tabs={tabs} />
        </>
      }
    >
      <LienWaiverToolbar
        direction={direction ?? ''}
        status={status ?? ''}
        projects={projects.rows}
        vendors={vendors.rows}
        canManage={can(authz, 'compliance.manage')}
      />

      {waivers.length === 0 ? (
        <EmptyState title={t('lienWaivers.empty.title')} description={t('lienWaivers.empty.description')} />
      ) : (
        <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('lienWaivers.columns.number')}</TableHead>
                <TableHead>{t('lienWaivers.columns.party')}</TableHead>
                <TableHead>{t('lienWaivers.columns.project')}</TableHead>
                <TableHead>{t('lienWaivers.columns.type')}</TableHead>
                <TableHead>{t('lienWaivers.columns.through')}</TableHead>
                <TableHead className="text-right">{t('lienWaivers.columns.amount')}</TableHead>
                <TableHead>{t('lienWaivers.columns.status')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {waivers.map((waiver) => {
                const rowQuery = new URLSearchParams(query)
                rowQuery.set('waiver', waiver.id)
                return (
                  <TableRow key={waiver.id}>
                    <TableCell className="font-medium">
                      <Link href={`/compliance/lien-waivers?${rowQuery}`} className="hover:underline">
                        {waiver.waiverNumber}
                      </Link>
                      <span className="ml-2 text-xs text-slate-400">{t(`direction.${waiver.direction}`)}</span>
                    </TableCell>
                    <TableCell>{waiver.partyName}</TableCell>
                    <TableCell className="text-slate-500 dark:text-slate-400">{waiver.projectName}</TableCell>
                    <TableCell className="text-xs">{t(`waiverType.${waiver.waiverType}`)}</TableCell>
                    <TableCell className="tabular-nums">{waiver.throughDate}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {money(waiver.amount, { currency: waiver.currency })}
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_TONE[waiver.status] ?? 'secondary'}>
                        {t(`waiverStatus.${waiver.status}`)}
                      </Badge>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {open ? (
        <LienWaiverDrawer
          waiver={open}
          openBills={openBills}
          closeHref={`/compliance/lien-waivers${query.toString() ? `?${query}` : ''}`}
          canManage={can(authz, 'compliance.manage')}
        />
      ) : null}
    </ListPageLayout>
  )
}

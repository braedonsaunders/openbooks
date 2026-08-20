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
  TableRow,
} from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { ModuleHomeTabs } from '../../../../components/module-home/ui'
import { can, requirePermission } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'
import {
  loadComplianceClasses,
  loadComplianceMatrix,
  loadVendorCertificates,
  loadVendorWaivers,
  requireComplianceFeature,
  stateTone,
} from '../../../../lib/compliance'
import { loadRequirementPolicies } from '@openbooks/engine/src/compliance.ts'
import { FORM_TYPES } from '@openbooks/engine/src/information-returns.ts'
import { pickString } from '../../../../lib/list-params'
import { getMoneyFormatter } from '@/lib/money-server'
import { complianceTabs } from '../tabs'
import { VendorComplianceDrawer } from './VendorComplianceDrawer'
import { MatrixFilters } from './MatrixFilters'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('compliance')
  return { title: t('vendors.title') }
}

/**
 * The subcontractor compliance matrix: one row per classified vendor, one cell
 * per policy that applies to it. The grid is the point — a per-vendor list makes
 * it impossible to see that nine subs all let the same certificate lapse.
 *
 * Every cell is the SAME evaluation the payment engine performs, so a green row
 * here is a promise the pay run will keep.
 */
export default async function ComplianceVendorsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('compliance.read')
  const orgId = authz.user.orgId
  await requireComplianceFeature(orgId)
  const t = await getTranslations('compliance')
  const { money } = await getMoneyFormatter()
  const sp = await searchParams
  const classId = pickString(sp.class) ?? null
  const stateFilter = pickString(sp.state) ?? null
  const openVendor = pickString(sp.vendor) ?? null

  const [matrix, projectsEnabled] = await Promise.all([
    loadComplianceMatrix({
      orgId,
      classId,
      states: stateFilter === 'attention'
        ? ['missing', 'expired', 'insufficient', 'awaiting_verification', 'rejected']
        : stateFilter === 'expiring'
          ? ['expiring']
          : undefined,
    }),
    isFeatureEnabled(orgId, 'projects'),
  ])
  const tabs = await complianceTabs('/compliance/vendors', { projectsEnabled })

  // The drawer's data loads only when a vendor is actually open.
  const drawerData = openVendor
    ? await (async () => {
        const [vendor, certificates, exceptions, policies, classes, projects] = await Promise.all([
          db.execute<Record<string, unknown>>(sql`
            select p.id, p.display_name as name, p.legal_name as "legalName",
                   vr.compliance_class_id as "complianceClassId",
                   vr.information_return_form as "informationReturnForm",
                   vr.information_return_box as "informationReturnBox",
                   vr.tax_classification as "taxClassification",
                   vr.tin_last4 as "tinLast4", vr.tin_type as "tinType",
                   coalesce(vr.backup_withholding, false) as "backupWithholding",
                   coalesce(vr.is_t4a, false) as reportable
              from parties p
              join vendor_roles vr on vr.party_id = p.id and vr.org_id = p.org_id
             where p.org_id = ${orgId} and p.id = ${openVendor}`),
          loadVendorCertificates(orgId, openVendor),
          loadVendorWaivers(orgId, openVendor),
          loadRequirementPolicies(orgId),
          loadComplianceClasses(orgId),
          db.execute<{ id: string; label: string }>(sql`
            select id, coalesce(code || ' · ' || name, name) as label from projects
             where org_id = ${orgId} and is_active order by code nulls last, name limit 500`),
        ])
        const row = vendor.rows[0]
        if (!row) return null
        return {
          vendor: row as never,
          certificates,
          exceptions,
          policies,
          classes,
          projects: projects.rows,
          status: matrix.rows.find((r) => r.partyId === openVendor) ?? null,
        }
      })()
    : null

  const columns = matrix.policies

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader title={t('vendors.title')} description={t('vendors.description')} />
          <ModuleHomeTabs tabs={tabs} />
        </>
      }
    >
      <MatrixFilters classes={matrix.classes} classId={classId} state={stateFilter} />

      {matrix.rows.length === 0 ? (
        <EmptyState title={t('vendors.empty.title')} description={t('vendors.empty.description')} />
      ) : (
        <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 bg-white dark:bg-slate-900">{t('vendors.columns.vendor')}</TableHead>
                <TableHead>{t('vendors.columns.class')}</TableHead>
                <TableHead>{t('vendors.columns.status')}</TableHead>
                {columns.map((policy) => (
                  <TableHead key={policy.id} className="whitespace-nowrap text-center">
                    {policy.code}
                  </TableHead>
                ))}
                <TableHead className="text-right">{t('vendors.columns.exposure')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {matrix.rows.map((row) => (
                <TableRow key={row.partyId}>
                  <TableCell className="sticky left-0 bg-white font-medium dark:bg-slate-900">
                    <Link
                      href={`/compliance/vendors?${new URLSearchParams({
                        ...(classId ? { class: classId } : {}),
                        ...(stateFilter ? { state: stateFilter } : {}),
                        vendor: row.partyId,
                      })}`}
                      className="hover:underline"
                    >
                      {row.vendorName}
                    </Link>
                  </TableCell>
                  <TableCell className="text-slate-500 dark:text-slate-400">{row.className}</TableCell>
                  <TableCell>
                    <Badge variant={stateTone(row.overall)}>{t(`states.${row.overall}`)}</Badge>
                  </TableCell>
                  {columns.map((policy) => {
                    const finding = row.findings.find((f) => f.requirementId === policy.id)
                    if (!finding) {
                      return (
                        <TableCell key={policy.id} className="text-center text-slate-300 dark:text-slate-600">
                          —
                        </TableCell>
                      )
                    }
                    return (
                      <TableCell key={policy.id} className="text-center">
                        <span
                          title={`${t(`states.${finding.state}`)}${
                            finding.expiresOn ? ` · ${finding.expiresOn}` : ''
                          }${finding.reasons.length ? ` · ${finding.reasons.map((r) => t(`reasons.${r}`)).join(', ')}` : ''}`}
                        >
                          <Badge variant={stateTone(finding.state)}>
                            {finding.state === 'compliant'
                              ? '✓'
                              : finding.state === 'expiring'
                                ? `${finding.daysToExpiry ?? 0}d`
                                : finding.state === 'waived'
                                  ? '~'
                                  : '!'}
                          </Badge>
                        </span>
                      </TableCell>
                    )
                  })}
                  <TableCell className="text-right tabular-nums">
                    {Number(row.openBalance) > 0 ? (
                      <span className={row.blocksPayment ? 'font-semibold text-red-600 dark:text-red-400' : ''}>
                        {money(Number(row.openBalance))}
                      </span>
                    ) : (
                      <span className="text-slate-300 dark:text-slate-600">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {drawerData ? (
        <VendorComplianceDrawer
          data={drawerData}
          closeHref={`/compliance/vendors?${new URLSearchParams({
            ...(classId ? { class: classId } : {}),
            ...(stateFilter ? { state: stateFilter } : {}),
          })}`}
          formTypes={[...FORM_TYPES]}
          canManage={can(authz, 'compliance.manage')}
          canVerify={can(authz, 'compliance.verify')}
          canWaive={can(authz, 'compliance.waive')}
          currentUserId={authz.user.id}
        />
      ) : null}
    </ListPageLayout>
  )
}

import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
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
import { FORM_TYPES } from '@openbooks/engine/src/information-returns.ts'
import { ListPageLayout } from '../../../../components/page-layout'
import { ModuleHomeTabs } from '../../../../components/module-home/ui'
import { can, requirePermission } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'
import {
  loadFilings,
  loadInformationReturnReadiness,
  requireComplianceFeature,
} from '../../../../lib/compliance'
import { getMoneyFormatter } from '@/lib/money-server'
import { complianceTabs } from '../tabs'
import { NewFilingButton } from './NewFilingButton'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('compliance')
  return { title: t('informationReturns.title') }
}

const STATUS_TONE: Record<string, 'success' | 'warning' | 'secondary' | 'outline' | 'destructive'> = {
  draft: 'outline',
  computed: 'warning',
  finalized: 'success',
  filed: 'success',
  void: 'secondary',
}

/**
 * Information-return filings by year. One row per (year, form, filing entity),
 * with the readiness queue underneath — the list of vendors that will make a
 * filing wrong if nobody chases them before January.
 */
export default async function InformationReturnsPage() {
  const authz = await requirePermission('compliance.read')
  const orgId = authz.user.orgId
  await requireComplianceFeature(orgId)
  const t = await getTranslations('compliance')
  const { money } = await getMoneyFormatter()
  const lastYear = new Date().getUTCFullYear() - 1

  const [filings, readiness, projectsEnabled] = await Promise.all([
    loadFilings(orgId),
    loadInformationReturnReadiness(orgId, lastYear),
    isFeatureEnabled(orgId, 'projects'),
  ])
  const tabs = await complianceTabs('/compliance/information-returns', { projectsEnabled })

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title={t('informationReturns.title')}
            description={t('informationReturns.description')}
            actions={
              can(authz, 'compliance.manage') ? (
                <NewFilingButton formTypes={[...FORM_TYPES]} defaultYear={lastYear} />
              ) : undefined
            }
          />
          <ModuleHomeTabs tabs={tabs} />
        </>
      }
    >
      {filings.length === 0 ? (
        <EmptyState
          title={t('informationReturns.empty.title')}
          description={t('informationReturns.empty.description')}
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('informationReturns.columns.year')}</TableHead>
                <TableHead>{t('informationReturns.columns.form')}</TableHead>
                <TableHead>{t('informationReturns.columns.entity')}</TableHead>
                <TableHead className="text-right">{t('informationReturns.columns.recipients')}</TableHead>
                <TableHead className="text-right">{t('informationReturns.columns.total')}</TableHead>
                <TableHead>{t('informationReturns.columns.status')}</TableHead>
                <TableHead>{t('informationReturns.columns.attention')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filings.map((filing) => (
                <TableRow key={filing.id}>
                  <TableCell className="font-medium tabular-nums">
                    <Link href={`/compliance/information-returns/${filing.id}`} className="hover:underline">
                      {filing.taxYear}
                    </Link>
                  </TableCell>
                  <TableCell>{filing.formType}</TableCell>
                  <TableCell className="text-slate-500 dark:text-slate-400">
                    {filing.subsidiaryName ?? t('informationReturns.orgRoot')}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {filing.includedCount}
                    {filing.excludedCount > 0 ? (
                      <span className="ml-1 text-xs text-slate-400">
                        {t('informationReturns.excluded', { count: filing.excludedCount })}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {money(Number(filing.filedTotal), { currency: filing.currency })}
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_TONE[filing.status] ?? 'secondary'}>
                      {t(`filingStatus.${filing.status}`)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {filing.missingTinCount > 0 ? (
                      <Badge variant="destructive">
                        {t('informationReturns.missingTin', { count: filing.missingTinCount })}
                      </Badge>
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

      <section className="mt-6">
        <h2 className="mb-1 text-sm font-semibold text-slate-800 dark:text-slate-100">
          {t('informationReturns.readinessTitle', { year: lastYear })}
        </h2>
        <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
          {t('informationReturns.readinessDescription')}
        </p>
        {readiness.length === 0 ? (
          <p className="rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/20 dark:text-emerald-300">
            {t('informationReturns.readinessClear')}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('informationReturns.columns.vendor')}</TableHead>
                  <TableHead>{t('informationReturns.columns.issue')}</TableHead>
                  <TableHead>{t('informationReturns.columns.classification')}</TableHead>
                  <TableHead className="text-right">{t('informationReturns.columns.paid')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {readiness.map((row) => (
                  <TableRow key={row.partyId}>
                    <TableCell className="font-medium">
                      <Link href={`/compliance/vendors?vendor=${row.partyId}`} className="hover:underline">
                        {row.vendorName}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant={row.reportable ? 'destructive' : 'warning'}>
                        {!row.reportable
                          ? t('readiness.unflagged')
                          : !row.hasTin
                            ? t('readiness.missingTin')
                            : t('readiness.noForm')}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-slate-500 dark:text-slate-400">
                      {row.taxClassification ? t(`taxClassification.${row.taxClassification}`) : '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{money(Number(row.paidThisYear))}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </ListPageLayout>
  )
}

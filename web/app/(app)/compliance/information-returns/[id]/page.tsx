import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@openbooks/ui'
import { formDefinition } from '@openbooks/engine/src/information-returns.ts'
import { ListPageLayout } from '../../../../../components/page-layout'
import { can, requirePermission } from '../../../../../lib/authz'
import { loadFiling, requireComplianceFeature } from '../../../../../lib/compliance'
import { isUuid } from '../../../../../lib/list-params'
import { FilingWorksheet } from './FilingWorksheet'

export const dynamic = 'force-dynamic'

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const t = await getTranslations('compliance')
  const { id } = await params
  if (!isUuid(id)) return { title: t('informationReturns.title') }
  return { title: t('informationReturns.title') }
}

/**
 * One filing's recipient worksheet: the computed box amounts, the adjustments a
 * person made and why, and the actions that move the filing forward.
 *
 * The worksheet is the artefact an accountant reviews before anything is
 * transmitted, so the ledger figure and the filed figure are both visible on
 * every row — never one silently replacing the other.
 */
export default async function FilingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const authz = await requirePermission('compliance.read')
  const orgId = authz.user.orgId
  await requireComplianceFeature(orgId)
  const { id } = await params
  if (!isUuid(id)) notFound()
  const filing = await loadFiling(orgId, id)
  if (!filing) notFound()
  const t = await getTranslations('compliance')
  const form = formDefinition(filing.formType)

  return (
    <ListPageLayout
      header={
        <PageHeader
          title={`${filing.formType} · ${filing.taxYear}`}
          description={t('informationReturns.detailDescription', {
            entity: filing.subsidiaryName ?? t('informationReturns.orgRoot'),
            threshold: `${filing.currency} ${filing.threshold}`,
          })}
          back={{ href: '/compliance/information-returns', label: t('informationReturns.title') }}
        />
      }
    >
      <FilingWorksheet
        filing={filing}
        boxes={form.boxes}
        canManage={can(authz, 'compliance.manage')}
        canFile={can(authz, 'compliance.file')}
      />
    </ListPageLayout>
  )
}

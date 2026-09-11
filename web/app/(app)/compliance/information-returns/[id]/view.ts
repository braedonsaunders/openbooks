import 'server-only'

import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { formDefinition } from '@openbooks/engine/src/information-returns.ts'
import { page, pageHeader, ref, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { can, requirePermission } from '../../../../../lib/authz'
import { loadFiling, requireComplianceFeature } from '../../../../../lib/compliance'
import { isUuid } from '../../../../../lib/list-params'
import type { FilingWorksheet } from './FilingWorksheet'

/**
 * One information-return filing's recipient worksheet, split into a loader and
 * a spec.
 *
 * The worksheet is the artefact an accountant reviews before anything is
 * transmitted, so the ledger figure and the filed figure are both visible on
 * every row — never one silently replacing the other. That is the component's
 * job and it stays whole: per-row adjustment forms, the reason capture, the
 * file/void actions and their confirmations are all client state.
 *
 * The title interpolates two loader-resolved values (`formType · taxYear`),
 * which is string building — so the loader builds it. A spec has no `+`.
 */

type WorksheetProps = Parameters<typeof FilingWorksheet>[0]

export interface FilingDetailData {
  title: string
  description: string
  backHref: string
  backLabel: string
  filing: WorksheetProps['filing']
  boxes: WorksheetProps['boxes']
  canManage: boolean
  canFile: boolean
}

export async function loadFilingDetail(id: string): Promise<FilingDetailData> {
  const authz = await requirePermission('compliance.read')
  const orgId = authz.user.orgId
  await requireComplianceFeature(orgId)
  if (!isUuid(id)) notFound()
  const filing = await loadFiling(orgId, id)
  if (!filing) notFound()
  const t = await getTranslations('compliance')
  const form = formDefinition(filing.formType)

  return {
    title: `${filing.formType} · ${filing.taxYear}`,
    description: t('informationReturns.detailDescription', {
      entity: filing.subsidiaryName ?? t('informationReturns.orgRoot'),
      threshold: `${filing.currency} ${filing.threshold}`,
    }),
    backHref: '/compliance/information-returns',
    backLabel: t('informationReturns.title'),
    filing,
    boxes: form.boxes,
    canManage: can(authz, 'compliance.manage'),
    canFile: can(authz, 'compliance.file'),
  }
}

const f = ref<FilingDetailData>()

export function filingDetailSpec(data: FilingDetailData): PageSpec {
  return page({
    route: '/compliance/information-returns/[id]',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        back: { href: f('backHref'), label: f('backLabel') },
      }),
    ],
    body: [
      widgetBlock('filing-worksheet', {
        filing: data.filing,
        boxes: data.boxes,
        canManage: data.canManage,
        canFile: data.canFile,
      }),
    ],
  })
}

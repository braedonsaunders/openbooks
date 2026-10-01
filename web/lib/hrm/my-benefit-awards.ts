import 'server-only'
import { getTranslations } from 'next-intl/server'
import { myBenefitStatement } from '@openbooks/engine/hrm/benefits'
import type { Authz } from '../authz'
import { getMoneyFormatter } from '../money-server'

export interface MyBenefitAwardRow {
  id: string
  programName: string
  periodLabel: string
  valueLabel: string
  statusLabel: string
}

export interface MyBenefitAwardsData {
  paidAwards: MyBenefitAwardRow[]
  pendingAwards: MyBenefitAwardRow[]
  awardsRefusal: { title: string; message: string } | null
  awardsText: Record<'paidTitle' | 'pendingTitle' | 'hint' | 'paidEmpty' | 'pendingEmpty' | 'program' | 'period' | 'value' | 'status', string>
}

/** Self-service reads its own employments; no HR aggregate reaches this projection. */
export async function loadMyBenefitAwards(authz: Authz): Promise<MyBenefitAwardsData> {
  const t = await getTranslations('hrm')
  const textKeys = ['paidTitle', 'pendingTitle', 'hint', 'paidEmpty', 'pendingEmpty', 'program', 'period', 'value', 'status'] as const
  const awardsText = Object.fromEntries(textKeys.map((key) => [key, t(`me.benefits.awards.${key}`)])) as MyBenefitAwardsData['awardsText']
  try {
    const [statements, { money }] = await Promise.all([
      myBenefitStatement({ orgId: authz.user.orgId, actorId: authz.user.id }),
      getMoneyFormatter(authz.user.orgId),
    ])
    const project = (award: (typeof statements)[number]['paidAwards'][number]): MyBenefitAwardRow => ({
      id: award.id,
      programName: award.programName,
      periodLabel: award.periodTo ? `${award.periodFrom} – ${award.periodTo}` : award.periodFrom,
      valueLabel: money(award.value, { currency: award.currency }),
      statusLabel: t(`portfolio.awardStatus.${award.status}`),
    })
    return {
      awardsText, awardsRefusal: null,
      paidAwards: statements.flatMap((statement) => statement.paidAwards.map(project)),
      pendingAwards: statements.flatMap((statement) => statement.pendingAwards.map(project)),
    }
  } catch (error) {
    return { awardsText, paidAwards: [], pendingAwards: [], awardsRefusal: {
      title: t('me.benefits.awards.refusalTitle'),
      message: error instanceof Error ? error.message : t('portfolio.loadFailed'),
    } }
  }
}

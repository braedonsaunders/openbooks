import 'server-only'

import { getTranslations } from 'next-intl/server'
import { getFeedbackSettings } from '@openbooks/engine/hrm/performance'
import { page, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { can, requirePermission } from '../../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../../lib/feature-gates'

export async function loadPerformanceSetup() {
  const authz = await requirePermission('hrm.performance.manage')
  await requireFeatureEnabled(authz.user.orgId, 'hrm')
  await requireFeatureEnabled(authz.user.orgId, 'hrmPerformance')
  const t = await getTranslations('hrm')
  const settings = await getFeedbackSettings({ orgId: authz.user.orgId, actorId: authz.user.id })
  return {
    title: t('performance.workspace.setupTitle'),
    description: t('performance.workspace.setupDescription'),
    canManageSetup: can(authz, 'admin.setup.manage'),
    formsTitle: t('performance.workspace.reviewForms'),
    formsDescription: t('performance.workspace.reviewFormsDescription'),
    settings: {
      title: t('performance.continuous.feedback.settingsTitle'),
      anyoneLabel: t('performance.continuous.feedback.anyoneLabel'),
      managersLabel: t('performance.continuous.feedback.managersLabel'),
      saveLabel: t('performance.continuous.feedback.saveLabel'),
      failed: t('performance.actionFailed'),
      current: settings.publicPraiseBy,
    },
  }
}

export type PerformanceSetupData = Awaited<ReturnType<typeof loadPerformanceSetup>>

export function performanceSetupSpec(data: PerformanceSetupData): PageSpec {
  return page({ route: '/admin/setup/performance', layout: 'bare', header: [], body: [widgetBlock('hrm-performance-setup', { data })] })
}

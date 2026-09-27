import 'server-only'

import { notFound } from 'next/navigation'
import { page, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../../../lib/authz'
import { isFeatureEnabled } from '../../../../../../lib/features'
import { listCompetencyOptions, loadReviewTemplate } from '../../../../../../lib/setup/hrm-builders'
import type { ReviewTemplateNode } from '../../../../../../lib/setup/hrm-builder-outline'
import type { CompetencyChoice } from '../ReviewTemplateBuilder'

/**
 * One review template's builder page: the template with its ordered
 * sections and questions, plus the competency choices a competency section
 * may attach (only while competencies are switched on — the attach API
 * refuses otherwise, so the field is not offered).
 */

export interface ReviewTemplateBuilderData {
  template: ReviewTemplateNode
  competencies: CompetencyChoice[] | null
}

export async function loadReviewTemplateBuilder(id: string): Promise<ReviewTemplateBuilderData> {
  const authz = await requirePermission('admin.setup.manage')
  const orgId = authz.user.orgId
  if (!(await isFeatureEnabled(orgId, 'hrm'))) notFound()
  const template = await loadReviewTemplate(orgId, id)
  if (!template) notFound()
  const competenciesOn =
    (await isFeatureEnabled(orgId, 'hrmPerformance')) && (await isFeatureEnabled(orgId, 'hrmCompetencies'))
  return { template, competencies: competenciesOn ? await listCompetencyOptions(orgId) : null }
}

export function reviewTemplateBuilderSpec(data: ReviewTemplateBuilderData): PageSpec {
  return page({
    route: '/admin/setup/review-templates/[id]',
    // One client island: the outline, the inspector drafts, drag state and
    // the live preview all share state a spec cannot name.
    layout: 'bare',
    header: [],
    body: [widgetBlock('review-template-builder', { template: data.template, competencies: data.competencies })],
  })
}

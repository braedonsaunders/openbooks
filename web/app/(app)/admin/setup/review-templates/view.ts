import 'server-only'

import { page, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../../lib/feature-gates'
import { listReviewTemplates } from '../../../../../lib/setup/hrm-builders'
import type { ReviewTemplateCard } from './ReviewTemplateIndex'

/**
 * Review templates index — the only entry point to review-form setup. Each
 * card opens that template's builder page. Gated like the Setup entity it
 * replaces: admin.setup.manage and the hrm feature.
 */

export interface ReviewTemplatesData {
  templates: ReviewTemplateCard[]
}

export async function loadReviewTemplates(): Promise<ReviewTemplatesData> {
  const authz = await requirePermission('admin.setup.manage')
  const orgId = authz.user.orgId
  await requireFeatureEnabled(orgId, 'hrm')
  return { templates: await listReviewTemplates(orgId) }
}

export function reviewTemplatesSpec(data: ReviewTemplatesData): PageSpec {
  return page({
    route: '/admin/setup/review-templates',
    // The setup workspace renders its own shell; the index is one client
    // island (create dialog + navigation).
    layout: 'bare',
    header: [],
    body: [widgetBlock('review-template-index', { templates: data.templates })],
  })
}

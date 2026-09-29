import 'server-only'

import { page, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../../lib/feature-gates'
import { listPipelineTemplates } from '../../../../../lib/setup/hrm-builders'
import type { PipelineCard } from './PipelineIndex'

/**
 * Hiring pipelines index — the only entry point to funnel setup. Each card
 * opens that pipeline's builder page. Gated like the Setup entity it
 * replaces: admin.setup.manage and the hrm feature.
 */

export interface HiringPipelinesData {
  pipelines: PipelineCard[]
}

export async function loadHiringPipelines(): Promise<HiringPipelinesData> {
  const authz = await requirePermission('admin.setup.manage')
  const orgId = authz.user.orgId
  await requireFeatureEnabled(orgId, 'hrm')
  return { pipelines: await listPipelineTemplates(orgId) }
}

export function hiringPipelinesSpec(data: HiringPipelinesData): PageSpec {
  return page({
    route: '/admin/setup/hiring-pipelines',
    layout: 'bare',
    header: [],
    body: [widgetBlock('hiring-pipeline-index', { pipelines: data.pipelines })],
  })
}

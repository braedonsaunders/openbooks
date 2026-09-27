import 'server-only'

import { notFound } from 'next/navigation'
import { page, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../../lib/authz'
import { isFeatureEnabled } from '../../../../../lib/features'
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
  if (!(await isFeatureEnabled(orgId, 'hrm'))) notFound()
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

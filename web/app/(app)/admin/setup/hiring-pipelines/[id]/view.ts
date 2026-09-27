import 'server-only'

import { notFound } from 'next/navigation'
import { page, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../../../lib/authz'
import { isFeatureEnabled } from '../../../../../../lib/features'
import { loadPipelineTemplateNode } from '../../../../../../lib/setup/hrm-builders'
import type { PipelineTemplateNode } from '../../../../../../lib/setup/hrm-builder-outline'

/**
 * One hiring pipeline's builder page: the pipeline, its ordered stages with
 * the applications sitting on each and the interview kits pinned to them.
 */

export interface PipelineBuilderData {
  pipeline: PipelineTemplateNode
}

export async function loadPipelineBuilder(id: string): Promise<PipelineBuilderData> {
  const authz = await requirePermission('admin.setup.manage')
  const orgId = authz.user.orgId
  if (!(await isFeatureEnabled(orgId, 'hrm'))) notFound()
  const pipeline = await loadPipelineTemplateNode(orgId, id)
  if (!pipeline) notFound()
  return { pipeline }
}

export function pipelineBuilderSpec(data: PipelineBuilderData): PageSpec {
  return page({
    route: '/admin/setup/hiring-pipelines/[id]',
    // One client island: the stage list, drag state, the stage-flow strip and
    // the inspector drafts share state a spec cannot name.
    layout: 'bare',
    header: [],
    body: [widgetBlock('hiring-pipeline-builder', { pipeline: data.pipeline })],
  })
}

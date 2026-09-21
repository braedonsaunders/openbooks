import 'server-only'

import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { frame, page, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../../lib/authz'
import { isFeatureEnabled } from '../../../../../lib/features'
import { isUuid } from '../../../../../lib/list-params'
import { listAutomations, listAutomationRuns } from '@openbooks/engine/src/automations/services.ts'
import type { BuilderAutomation, BuilderRun } from './AutomationBuilder'

/**
 * The automation recipe builder page, split into a loader and a spec.
 *
 * One linear-recipe client island over loader-resolved props (the
 * brief-sanctioned recipe mode beside the graph-based flows builder):
 * Trigger, Who and When, and Actions panels, a Simulate card, and the
 * Runs tab. No org id, user id, or Authz crosses into the spec.
 */

export interface AutomationBuilderData {
  automation: BuilderAutomation
  runs: BuilderRun[]
  canSimulate: boolean
  saveFailed: string
  title: string
  description: string
  backHref: string
  backLabel: string
}

export async function loadAutomationBuilder(id: string): Promise<AutomationBuilderData> {
  const authz = await requirePermission('automations.read')
  if (!(await isFeatureEnabled(authz.user.orgId, 'automations'))) notFound()
  if (!isUuid(id)) notFound()
  const t = await getTranslations('admin.automations')
  const automations = await listAutomations(authz.user.orgId, authz.user.id)
  const automation = automations.find((a) => a.id === id)
  if (!automation) notFound()
  const runs = await listAutomationRuns(authz.user.orgId, authz.user.id, id)
  return {
    automation: {
      id: automation.id,
      name: automation.name,
      description: automation.description,
      status: automation.status,
      version: automation.version,
      trigger: (automation.trigger ?? {}) as Record<string, unknown>,
      rules: (automation.rules ?? {}) as Record<string, unknown>,
      conditions: (automation.conditions ?? {}) as Record<string, unknown>,
      actions: (Array.isArray(automation.actions) ? automation.actions : []) as Record<string, unknown>[],
      errorMessage: automation.errorMessage,
    },
    runs: runs.map((r) => ({
      id: r.id,
      status: r.status,
      version: r.version,
      subjectKind: r.subjectKind,
      createdAt: String(r.createdAt),
    })),
    canSimulate: await isFeatureEnabled(authz.user.orgId, 'automationSimulator'),
    saveFailed: t('builder.saveFailed'),
    title: automation.name,
    description: t('builder.description'),
    backHref: '/admin/automations',
    backLabel: t('backToList'),
  }
}

export function automationBuilderSpec(data: AutomationBuilderData): PageSpec {
  return page({
    route: '/admin/automations/[id]',
    layout: 'bare',
    header: [],
    body: [
      frame('padded', [
        widgetBlock('automation-builder', {
          automation: data.automation,
          runs: data.runs,
          canSimulate: data.canSimulate,
          saveFailed: data.saveFailed,
          backHref: data.backHref,
          backLabel: data.backLabel,
        }),
      ]),
    ],
  })
}

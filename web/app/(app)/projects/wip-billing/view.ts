import 'server-only'

import { page, pageHeader, ref, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { can, requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { isFeatureEnabled } from '../../../../lib/features'
import { isUuid, pickString } from '../../../../lib/list-params'
import {
  listPrebills,
  listUnbilledProjects,
  listWipProjects,
  loadPrebill,
  prebillApprovalFlowsConfigured,
} from '../../../../lib/wip-billing'
import { requireWipBillingFeature } from '../../../../lib/wip-billing-gate'
import type { WipBillingWorkspace } from './WipBillingWorkspace'

/**
 * Pre-billing, split into a loader and a spec.
 *
 * The workspace is one client component and stays whole: it owns the board
 * and table views, the bill-run drawer, the worksheet drawer and every
 * lifecycle call. Decomposing it would strand that client state from the
 * actions it drives (the same reason the banking match page places
 * `match-workspace` whole).
 *
 * The loader applies the `projects.read` gate and both feature gates, scopes
 * every read to the caller's subsidiaries, resolves the ?prebill= selection
 * (uuid guard; a hidden or unknown id resolves to no selection), and passes
 * the permission and configuration decisions the workspace needs as plain
 * booleans.
 */

type WipBillingWorkspaceProps = Parameters<typeof WipBillingWorkspace>[0]

export interface WipBillingData {
  title: string
  description: string
  prebills: WipBillingWorkspaceProps['prebills']
  unbilled: WipBillingWorkspaceProps['unbilled']
  projects: WipBillingWorkspaceProps['projects']
  selected: WipBillingWorkspaceProps['selected']
  canManage: boolean
  canCreateInvoice: boolean
  customerPortalEnabled: boolean
  approvalFlowsConfigured: boolean
}

// node-pg returns timestamptz columns as Date objects; the spec data must be
// plain JSON, so normalize the instants the workspace re-parses with
// `new Date(...)`. The rendered instant is unchanged on either path.
function isoInstant(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value
}

function isoInstantOrNull(value: string | Date | null): string | null {
  return value == null ? null : isoInstant(value)
}

export async function loadWipBilling(
  sp: Record<string, string | string[] | undefined>,
): Promise<WipBillingData> {
  const authz = await requirePermission('projects.read')
  await requireFeatureEnabled(authz.user.orgId, 'wipBilling')
  await requireWipBillingFeature(authz.user.orgId)
  const orgId = authz.user.orgId
  const selectedId = pickString(sp.prebill)
  const [prebills, unbilled, projects, rawSelected, customerPortalEnabled, approvalFlowsConfigured] = await Promise.all([
    listPrebills(orgId, undefined, authz.allowedSubsidiaryIds),
    listUnbilledProjects(orgId, authz.allowedSubsidiaryIds),
    listWipProjects(orgId, authz.allowedSubsidiaryIds),
    selectedId && isUuid(selectedId) ? loadPrebill(orgId, selectedId, authz.allowedSubsidiaryIds) : null,
    isFeatureEnabled(orgId, 'customerPortal'),
    prebillApprovalFlowsConfigured(orgId),
  ])
  const selected = rawSelected
    ? {
        ...rawSelected,
        submittedAt: isoInstantOrNull(rawSelected.submittedAt as unknown as string | Date | null),
        approvedAt: isoInstantOrNull(rawSelected.approvedAt as unknown as string | Date | null),
        convertedAt: isoInstantOrNull(rawSelected.convertedAt as unknown as string | Date | null),
        voidedAt: isoInstantOrNull(rawSelected.voidedAt as unknown as string | Date | null),
        events: rawSelected.events.map((event) => ({
          ...event,
          occurredAt: isoInstant(event.occurredAt as unknown as string | Date),
        })),
      }
    : null
  return {
    title: 'Pre-billing',
    description: 'Turn unbilled work into reviewed, approved invoice packages — and deliver them with their backup.',
    prebills,
    unbilled,
    projects,
    selected,
    canManage: can(authz, 'projects.manage'),
    canCreateInvoice: can(authz, 'ar.create'),
    customerPortalEnabled,
    approvalFlowsConfigured,
  }
}

const f = ref<WipBillingData>()

export function wipBillingSpec(data: WipBillingData): PageSpec {
  return page({
    route: '/projects/wip-billing',
    layout: 'list',
    header: [pageHeader({ title: f('title'), description: f('description') })],
    body: [
      // The whole workspace, placed through one widget: it owns the board,
      // the drawers, the editable line inputs and every fetch mutation, so
      // splitting it would strand client state from the actions it drives.
      widgetBlock('wip-billing-workspace', {
        prebills: data.prebills,
        unbilled: data.unbilled,
        projects: data.projects,
        selected: data.selected,
        canManage: data.canManage,
        canCreateInvoice: data.canCreateInvoice,
        customerPortalEnabled: data.customerPortalEnabled,
        approvalFlowsConfigured: data.approvalFlowsConfigured,
      }),
    ],
  })
}

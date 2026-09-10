import 'server-only'

import { page, pageHeader, ref, widgetBlock, type PageSpec } from '@openbooks/viewspec'
import { can, requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { isUuid, pickString } from '../../../../lib/list-params'
import { listPrebills, listWipProjects, loadPrebill, wipAnalytics } from '../../../../lib/wip-billing'
import { requireWipBillingFeature } from '../../../../lib/wip-billing-gate'
import type { WipBillingWorkspace } from './WipBillingWorkspace'

/**
 * WIP & Prebilling, split into a loader and a spec.
 *
 * The workspace is one client component and stays whole: it owns the create
 * drawer, the detail drawer, per-line edit/hold/release forms, and every
 * transition/convert call. Decomposing it would strand that client state from
 * the actions it drives (the same reason the banking match page places
 * `match-workspace` whole).
 *
 * Everything here is loader work copied verbatim from page.tsx: the
 * `projects.read` gate, the two feature gates, the ?prebill= selection (uuid
 * guard, subsidiary guard inside the lib calls), and the three permission
 * decisions, which travel as plain booleans. The header strings are the
 * native page's literals — it uses no translations for them.
 */

type WipBillingWorkspaceProps = Parameters<typeof WipBillingWorkspace>[0]

export interface WipBillingData {
  title: string
  description: string
  prebills: WipBillingWorkspaceProps['prebills']
  projects: WipBillingWorkspaceProps['projects']
  analytics: WipBillingWorkspaceProps['analytics']
  selected: WipBillingWorkspaceProps['selected']
  canManage: boolean
  canApprove: boolean
  canCreateInvoice: boolean
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
  const selectedId = pickString(sp.prebill)
  const [prebills, projects, analytics, rawSelected] = await Promise.all([
    listPrebills(authz.user.orgId, undefined, authz.allowedSubsidiaryIds),
    listWipProjects(authz.user.orgId, authz.allowedSubsidiaryIds),
    wipAnalytics(authz.user.orgId, undefined, authz.allowedSubsidiaryIds),
    selectedId && isUuid(selectedId) ? loadPrebill(authz.user.orgId, selectedId, authz.allowedSubsidiaryIds) : null,
  ])
  // Org guard, subsidiary guard and the unknown-id case all resolve inside
  // loadPrebill (it re-lists through the same scoped query and returns null
  // for a hidden or missing id), so a null selection is data, not a branch.
  const selected = rawSelected
    ? {
        ...rawSelected,
        createdAt: isoInstant(rawSelected.createdAt as unknown as string | Date),
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
    title: 'WIP & Prebilling',
    description: 'Review unbilled project work, govern billing adjustments, and convert approved worksheets into draft invoices.',
    prebills,
    projects,
    analytics,
    selected,
    canManage: can(authz, 'projects.manage'),
    canApprove: can(authz, 'ar.approve'),
    canCreateInvoice: can(authz, 'ar.create'),
  }
}

const f = ref<WipBillingData>()

export function wipBillingSpec(data: WipBillingData): PageSpec {
  return page({
    layout: 'list',
    header: [pageHeader({ title: f('title'), description: f('description') })],
    body: [
      // The whole workspace, placed through one widget (see INTEGRATION.md):
      // it owns the create/detail drawers, the editable line inputs and every
      // fetch mutation, so splitting it would strand client state from the
      // actions it drives. The loader hands over exactly the props the native
      // page passes; the widget spreads them onto the same component.
      widgetBlock('wip-billing-workspace', {
        prebills: data.prebills,
        projects: data.projects,
        analytics: data.analytics,
        selected: data.selected,
        canManage: data.canManage,
        canApprove: data.canApprove,
        canCreateInvoice: data.canCreateInvoice,
      }),
    ],
  })
}

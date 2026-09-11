import 'server-only'

import { notFound, redirect } from 'next/navigation'
import { page, pageHeader, ref, widget, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../../lib/authz'
import { pickString } from '../../../../../lib/list-params'
import { loadChangeSetDetail } from '../../../../../lib/sandbox-change-sets'
import type { ChangeSetDrawer } from './ChangeSetDrawer'

/**
 * The sandbox change-set review list, split into a loader and a spec.
 *
 * Two things about this page are unusual and both stay out of the spec.
 *
 * It lists against the PRODUCTION org, not the current one — a sandbox
 * session reviewing what it captured — and it hardcodes `canManage`. Neither
 * travels: `EntityListSlot` decides both from the record type, the way it
 * already decides `bank_rule`'s cell formatting. A spec that could name
 * either org is a spec that could name the wrong one.
 *
 * And it is production-only. `envKind !== 'production'` redirects, which runs
 * in the loader so the gate runs in the loader.
 *
 * The copy is hardcoded English on the native page (this route has no catalog
 * entry yet), so the loader carries the same literals rather than inventing
 * keys that do not exist.
 */

type DrawerProps = Parameters<typeof ChangeSetDrawer>[0]

export interface ChangeSetsData {
  backHref: string
  backLabel: string
  title: string
  description: string
  sp: Record<string, string | string[] | undefined>
  /** `null` when no `?changeSet=` is selected; the widget omits the flyout. */
  drawer: (DrawerProps & { remountKey: string }) | null
}

export async function loadChangeSets(
  sp: Record<string, string | string[] | undefined>,
): Promise<ChangeSetsData> {
  const authz = await requirePermission('admin.sandboxes.manage')
  if (authz.user.envKind !== 'production') redirect('/admin/sandboxes')

  const id = pickString(sp.changeSet)
  const selected = id ? await loadChangeSetDetail(authz.user.productionOrgId, id) : null
  // A named change set that does not resolve is a 404, not an empty flyout —
  // the native contract, and the only way a bad id is distinguishable from a
  // hidden one is that it is NOT.
  if (id && !selected) notFound()

  return {
    backHref: '/admin/sandboxes',
    backLabel: 'Environments',
    title: 'Change sets',
    description:
      'Inspect captured configuration changes, record independent review and approval, then apply the approved changes to production.',
    sp,
    drawer: selected
      ? { remountKey: selected.id, detail: selected, actorId: authz.user.id }
      : null,
  }
}

const f = ref<ChangeSetsData>()

export function changeSetsSpec(data: ChangeSetsData): PageSpec {
  return page({
    route: '/admin/sandboxes/change-sets',
    layout: 'list',
    header: [
      pageHeader({
        back: { href: f('backHref'), label: f('backLabel') },
        title: f('title'),
        description: f('description'),
      }),
    ],
    body: [
      widgetBlock('entity-list-view', {
        recordType: 'change_set',
        sp: data.sp,
        // The widget ref resolves to nothing when `drawer` is null, which is
        // the native `: null` exactly.
        drawer: widget('change-set-drawer', { drawer: data.drawer }),
      }),
    ],
  })
}

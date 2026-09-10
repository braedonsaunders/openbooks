import 'server-only'

import type { ReactNode } from 'react'
import { can, getAuthz } from '../../lib/authz'
import { EntityListView } from '../entity-list-view'

/**
 * Slot for the universal entity list.
 *
 * `EntityListView` needs an org id, a user id and a permission decision. None
 * of those may travel through a spec: a spec is data, and data that names an
 * org id is a cross-tenant read waiting to happen. So the slot re-derives all
 * three from the session — the spec supplies only the record type and the URL
 * it was already rendering with.
 *
 * `drawer` and `emptyAction` are components, so the spec names widgets and the
 * caller resolves them, the same indirection the empty state uses for its
 * action button.
 */
export async function EntityListSlot({
  recordType,
  sp,
  drawer,
  emptyAction,
}: {
  recordType: string
  sp: Record<string, string | string[] | undefined>
  drawer?: ReactNode
  emptyAction?: ReactNode
}) {
  const authz = await getAuthz()
  if (!authz) return null
  return (
    <EntityListView
      recordType={recordType}
      orgId={authz.user.orgId}
      userId={authz.user.id}
      canManage={can(authz, 'admin.customization.manage')}
      sp={sp}
      drawer={drawer}
      emptyAction={emptyAction}
    />
  )
}

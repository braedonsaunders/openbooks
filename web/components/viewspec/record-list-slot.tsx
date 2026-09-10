import 'server-only'

import type { ReactNode } from 'react'
import { can, getAuthz } from '../../lib/authz'
import { RecordListView } from '../record-list-view'

/**
 * Slot for the universal record list — the documents twin of EntityListSlot.
 *
 * `RecordListView` needs an org id, a user id and a permission decision. None
 * of those may travel through a spec: a spec is data, and data that names an
 * org id is a cross-tenant read waiting to happen. So the slot re-derives all
 * three from the session; the spec supplies only the record type, the base
 * path, and the URL it was already rendering with.
 *
 * `drawer` and `emptyAction` are components, so the spec names widgets and the
 * caller resolves them — the same indirection the empty state uses for its
 * action. `renderRowActions` is a FUNCTION, which a spec can never carry, so
 * the registry entry builds it from a per-row widget ref instead.
 */
export async function RecordListSlot({
  recordType,
  basePath,
  sp,
  drawer,
  emptyAction,
  renderRowActions,
}: {
  recordType: string
  basePath: string
  sp: Record<string, string | string[] | undefined>
  drawer?: ReactNode
  emptyAction?: ReactNode
  renderRowActions?: Parameters<typeof RecordListView>[0]['renderRowActions']
}) {
  const authz = await getAuthz()
  if (!authz) return null
  return (
    <RecordListView
      recordType={recordType}
      basePath={basePath}
      orgId={authz.user.orgId}
      userId={authz.user.id}
      canManage={can(authz, 'admin.customization.manage')}
      sp={sp}
      drawer={drawer}
      emptyAction={emptyAction}
      renderRowActions={renderRowActions}
    />
  )
}

import 'server-only'

import { can, getAuthz } from '../../lib/authz'
import { SETUP_ENTITY_BY_KEY } from '../../lib/setup/registry'
import { SetupEntitySection } from '../../app/(app)/admin/setup/[entity]/SetupEntitySection'

/**
 * Slot for the registry-backed configuration sections that other modules
 * re-home from the Setup workspace — stock locations and bill-of-materials
 * under Inventory, rate books under Items.
 *
 * `SetupEntitySection` needs the live registry entry and the org id. The
 * entry is code, not data, so the spec names it by key and the slot looks it
 * up here; the org id is re-derived from the session because a spec must
 * never carry a capability or an org id. The manage gate is re-derived too,
 * exactly as the native page computes it.
 */
export async function SetupSectionSlot({
  entityKey,
  sp,
  basePath,
}: {
  entityKey: string
  sp: Record<string, string | string[] | undefined>
  basePath: string
}) {
  const authz = await getAuthz()
  if (!authz) return null
  const entity = SETUP_ENTITY_BY_KEY.get(entityKey)
  if (!entity) return null
  return (
    <SetupEntitySection
      entity={entity}
      orgId={authz.user.orgId}
      searchParams={sp}
      basePath={basePath}
      canManage={can(authz, 'admin.setup.manage')}
    />
  )
}

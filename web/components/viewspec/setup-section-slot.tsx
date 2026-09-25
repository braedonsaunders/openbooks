import 'server-only'

import { db } from '@openbooks/engine/src/platform/db.ts'
import { listSchedules } from '@openbooks/engine/src/hrm/construction/rates.ts'
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
  rowParam = 'row',
}: {
  entityKey: string
  sp: Record<string, string | string[] | undefined>
  basePath: string
  /** Namespaced drawer key for hosts mounting several sections (CK-09):
   *  each section reads and writes only its own key. */
  rowParam?: string
}) {
  const authz = await getAuthz()
  if (!authz) return null
  const entity = SETUP_ENTITY_BY_KEY.get(entityKey)
  if (!entity) return null
  // Rate schedules carry caller-dependent visibility (a B-anchored schedule
  // never reaches an A-scoped reader): resolve the visible ids through the
  // owning engine service so the generic section reads exactly those rows
  // instead of the whole org table. Every other entity keeps the plain
  // org-wide read.
  const visibleRowIds = entityKey === 'construction-rate-schedules'
    ? new Set((await listSchedules(db, authz.user.orgId, authz.user.id)).map((schedule) => schedule.id))
    : undefined
  return (
    <SetupEntitySection
      entity={entity}
      orgId={authz.user.orgId}
      actorId={authz.user.id}
      searchParams={sp}
      basePath={basePath}
      canManage={can(authz, 'admin.setup.manage')}
      allowedSubsidiaryIds={authz.allowedSubsidiaryIds}
      rowParam={rowParam}
      visibleRowIds={visibleRowIds}
    />
  )
}

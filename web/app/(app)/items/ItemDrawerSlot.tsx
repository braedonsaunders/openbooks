import 'server-only'

import type { ComponentProps } from 'react'
import { getTranslations } from 'next-intl/server'
import { can, getAuthz } from '../../../lib/authz'
import { resolvedFeatureState } from '../../../lib/features'
import { setupChildEntities, resolveSetupEntityGate } from '../../../lib/setup/registry'
import { pickString } from '../../../lib/list-params'
import { SetupEntitySection } from '../admin/setup/[entity]/SetupEntitySection'
import { ItemDrawer } from './ItemDrawer'

/** Item-owned configuration uses the same scoped list and drawer as setup records. */
export async function ItemDrawerSlot({ drawer, sp }: {
  drawer: (ComponentProps<typeof ItemDrawer> & { remountKey: string }) | null
  sp: Record<string, string | string[] | undefined>
}) {
  if (!drawer) return null
  const { remountKey, ...props } = drawer
  const authz = await getAuthz()
  if (!authz || !can(authz, 'items.read')) return null
  if (props.createMode || !can(authz, 'admin.setup.manage') || authz.allowedSubsidiaryIds !== null) {
    return <ItemDrawer key={remountKey} {...props} />
  }
  const features = await resolvedFeatureState(authz.user.orgId)
  const t = await getTranslations('admin.setup')
  const recordTabs = setupChildEntities('items')
    .filter((entity) => resolveSetupEntityGate(entity, features).enabled)
    .map((entity) => ({
      key: entity.key,
      label: t(`entities.${entity.key}.title`),
      content: pickString(sp.itemSetup) === entity.key ? (
        <SetupEntitySection
          entity={{ ...entity, columns: entity.columns.filter((column) => column.key !== 'itemId') }}
          orgId={authz.user.orgId}
          actorId={authz.user.id}
          searchParams={sp}
          basePath="/items"
          canManage={can(authz, 'items.manage')}
          allowedSubsidiaryIds={authz.allowedSubsidiaryIds}
          parent={{ recordKey: 'items', value: String(props.payload.item.id) }}
          rowParam="recordRow"
          paramPrefix="record"
          stacked
        />
      ) : null,
    }))
  return <ItemDrawer key={remountKey} {...props} recordTabs={recordTabs} />
}

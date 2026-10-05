import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { Plus } from 'lucide-react'
import { Button, PageHeader, UrlDrawer } from '@openbooks/ui'
import { EntityListView } from '@/components/entity-list-view'
import { ModuleHomeTabs } from '@/components/module-home/ui'
import { ListPageLayout } from '@/components/page-layout'
import { requirePermission, can } from '@/lib/authz'
import { requireFeatureEnabled } from '@/lib/feature-gates'
import { isUuid, pickString, mergeHref } from '@/lib/list-params'
import { itemsWorkspaceTabs } from '../tabs'
import { FamilyDrawer } from './FamilyDrawer'

export const dynamic = 'force-dynamic'

/**
 * Product families: one row per Size × Color matrix. Variants stay ordinary
 * items, so the matrix is managed here while stock, pricing and sales keep
 * working on the items list. Hidden while the Item variants gate is off.
 */
export default async function FamiliesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const auth = await requirePermission('items.read')
  await requireFeatureEnabled(auth.user.orgId, 'itemVariants')
  const sp = await searchParams
  const [t, tItems] = await Promise.all([getTranslations('items.families'), getTranslations('items')])
  const canManage = can(auth, 'items.manage')
  const selected = pickString(sp.family)
  if (selected && selected !== 'new' && !isUuid(selected)) notFound()
  if (selected === 'new' && !canManage) notFound()
  const tabs = itemsWorkspaceTabs({
    active: 'families',
    catalogLabel: tItems('list.viewCatalog'),
    rateBooksLabel: tItems('list.viewRateBooks'),
    familiesLabel: tItems('list.viewFamilies'),
    showRateBooks: false,
    showFamilies: true,
  })
  return <ListPageLayout header={<PageHeader title={t('title')} description={t('description')}
    actions={<>{canManage ? <Button asChild><Link href="/items/families?family=new"><Plus size={15} /> {t('newFamily')}</Link></Button> : null}<ModuleHomeTabs tabs={tabs} /></>} />}>
    <EntityListView recordType="item_family" orgId={auth.user.orgId} userId={auth.user.id}
      canManage={false} sp={sp} emptyTitle={t('empty')} drawer={selected ? <UrlDrawer open title={selected === 'new' ? t('newFamily') : t('drawerTitle')}
        closeHref={mergeHref('/items/families', sp, { family: undefined, drawerReturn: undefined })} size="2xl">
        <FamilyDrawer familyId={selected} canManage={canManage} />
      </UrlDrawer> : undefined} />
  </ListPageLayout>
}

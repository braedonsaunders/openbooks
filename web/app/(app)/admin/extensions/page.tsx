import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { UrlDrawer } from '@openbooks/ui'
import { ExtensionRequest } from './ExtensionRequest'
import { ExtensionDrawer } from './ExtensionDrawer'
import { ExtensionReview } from './ExtensionReview'
import { getExtensionDraft } from '@/lib/application/extensions'
import { ApplicationError } from '@/lib/application/errors'
import { applicationContextFromSession } from '@/lib/application/context'
import { requirePermission } from '@/lib/authz'
import { isUuid } from '@/lib/list-params'
import { ModuleView } from '@/components/viewspec/module-view'
import { adminExtensionsSpec, loadAdminExtensions } from './view'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export default async function ExtensionsAdminPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const data = await loadAdminExtensions(sp)
  const t = await getTranslations('admin.extensions')
  const draft = typeof sp.draft === 'string' && isUuid(sp.draft) ? await getExtensionDraft(applicationContextFromSession(await requirePermission('apps.manage'), 'api', crypto.randomUUID()), sp.draft).catch(error => { if (error instanceof ApplicationError && error.status === 404) notFound(); throw error }) : null
  return <>
    <ModuleView spec={adminExtensionsSpec(data)} data={data} searchParams={sp} trusted />
    {data.drawer ? <ExtensionDrawer {...data.drawer} closeHref="/admin/extensions" /> : null}
    {draft ? <ExtensionReview key={draft.id} draft={draft} /> : null}
    {sp.new === '1' && !draft && !data.drawerOpen && data.canAuthor ? <UrlDrawer open closeHref="/admin/extensions" size="xl" title={t('actions.new')}><ExtensionRequest /></UrlDrawer> : null}
  </>
}

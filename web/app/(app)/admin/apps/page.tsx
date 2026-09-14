import { notFound } from 'next/navigation'
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
export default async function ExtensionsAdminPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadAdminExtensions(sp)
  const draft =
    typeof sp.draft === 'string' && isUuid(sp.draft)
      ? await getExtensionDraft(
          applicationContextFromSession(
            await requirePermission('apps.manage'),
            'api',
            crypto.randomUUID(),
          ),
          sp.draft,
        ).catch((error) => {
          if (error instanceof ApplicationError && error.status === 404)
            notFound()
          throw error
        })
      : null
  return (
    <>
      <ModuleView
        spec={adminExtensionsSpec(data)}
        data={data}
        searchParams={sp}
        trusted
      />
      {data.drawer ? (
        <ExtensionDrawer {...data.drawer} closeHref="/admin/apps" />
      ) : null}
      {draft ? <ExtensionReview key={draft.id} draft={draft} /> : null}
      {sp.new === '1' && !draft && !data.drawerOpen && data.canAuthor ? (
        <ExtensionRequest />
      ) : null}
    </>
  )
}

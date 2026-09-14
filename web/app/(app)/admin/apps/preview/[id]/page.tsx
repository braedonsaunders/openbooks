import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { Alert, AlertDescription } from '@openbooks/ui'
import { requirePermission } from '@/lib/authz'
import { applicationContextFromSession } from '@/lib/application/context'
import { getExtensionDraft, validateExtensionBundle } from '@/lib/application/extensions'
import { ApplicationError } from '@/lib/application/errors'
import { parseManifest } from '@/lib/apps/manifest'
import { parseNativeExtension } from '@/lib/apps/native-ui'
import { parseObjectSpecs } from '@/lib/apps/objects'
import { isUuid } from '@/lib/list-params'
import { NativeScreens } from '../../../../apps/[key]/NativeExtension'
import { AppFrame } from '../../../../apps/[key]/AppFrame'

export const dynamic = 'force-dynamic'
export default async function ExtensionPreview({ params, searchParams }: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { id } = await params
  if (!isUuid(id)) notFound()
  const authz = await requirePermission('apps.manage')
  let draft
  try { draft = await getExtensionDraft(applicationContextFromSession(authz, 'api', crypto.randomUUID()), id) }
  catch (error) { if (error instanceof ApplicationError && error.status === 404) notFound(); throw error }
  const bundle = validateExtensionBundle(draft.bundle)
  const manifest = parseManifest(bundle.manifest).manifest!
  const entry = bundle.files.find(file => file.path === manifest.frontend.entry)!
  const t = await getTranslations('admin.extensions.draft')
  const notice = <Alert variant="info"><AlertDescription>{t('previewNotice')}</AlertDescription></Alert>
  if (manifest.frontend.renderer === 'native') return <>{notice}<NativeScreens ui={parseNativeExtension(entry.content)} appKey={manifest.key} name={manifest.name} description={manifest.description ?? null} grants={[]} searchParams={await searchParams} preview={{ id, objects: parseObjectSpecs(bundle.files) }} /></>
  return <>{notice}<AppFrame appKey={manifest.key} context={{ app: { id, key: manifest.key, name: manifest.name }, user: { id: authz.user.id, name: authz.user.name, roles: authz.user.roles.map(role => role.key) } }} previewDraftId={id} /></>
}

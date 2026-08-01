import Link from 'next/link'
import { PageHeader } from '@openbooks/ui'
import { requirePermission } from '@/lib/authz'
import { getAppByKey } from '@/lib/apps/store'
import { AppFrame } from './AppFrame'

export const runtime = 'nodejs'

export default async function AppRuntimePage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params
  const authz = await requirePermission('apps.use')
  const app = await getAppByKey(authz.user.orgId, key)

  if (!app || !app.activeVersionId) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-10">
        <PageHeader title="App not found" description="This app is not installed, or has no active version." />
        <Link href="/apps" className="text-sm text-blue-600 hover:underline">
          ← Back to apps
        </Link>
      </div>
    )
  }
  if (app.status !== 'installed') {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-10">
        <PageHeader title={app.name} description="This app is currently disabled." />
        <Link href="/apps" className="text-sm text-blue-600 hover:underline">
          ← Back to apps
        </Link>
      </div>
    )
  }

  const context = {
    app: { id: app.id, key: app.key, name: app.name },
    user: { id: authz.user.id, name: authz.user.name, roles: authz.user.roles.map(({ key }) => key) },
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b px-4 py-2">
        <Link href="/apps" className="text-sm text-neutral-500 hover:underline">
          Apps
        </Link>
        <span className="text-neutral-300">/</span>
        <span className="text-sm font-medium">{app.name}</span>
      </div>
      <div className="min-h-0 flex-1">
        <AppFrame appKey={app.key} context={context} />
      </div>
    </div>
  )
}

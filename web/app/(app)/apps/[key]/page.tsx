import { requirePermission } from '@/lib/authz'
import { getAppByKey } from '@/lib/apps/store'
import { AppNotice, AppRuntimeChrome } from './sections'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadAppRuntime, appRuntimeSpec } from './view'

export const runtime = 'nodejs'

export default async function AppRuntimePage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>
  // Optional: this route natively takes only `params`. The conversion needs a
  // query flag, and threading it through must not make the prop mandatory for
  // any caller that renders the component directly.
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const { key } = await params
  const sp = (await searchParams) ?? {}
  if (sp.__viewspec === '1') {
    const data = await loadAppRuntime(key)
    return (
      <>
        {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
        <meta name="x-viewspec-render" content="1" />
        <ModuleView spec={appRuntimeSpec(data)} data={data} searchParams={sp} trusted />
      </>
    )
  }

  const authz = await requirePermission('apps.use')
  const app = await getAppByKey(authz.user.orgId, key)

  if (!app || !app.activeVersionId) {
    return (
      <AppNotice
        title="App not found"
        description="This app is not installed, or has no active version."
        backHref="/apps"
        backLabel="← Back to apps"
      />
    )
  }
  if (app.status !== 'installed') {
    return (
      <AppNotice
        title={app.name}
        description="This app is currently disabled."
        backHref="/apps"
        backLabel="← Back to apps"
      />
    )
  }

  const context = {
    app: { id: app.id, key: app.key, name: app.name },
    user: { id: authz.user.id, name: authz.user.name, roles: authz.user.roles.map(({ key: roleKey }) => roleKey) },
  }

  return (
    <AppRuntimeChrome
      appKey={app.key}
      appName={app.name}
      appsHref="/apps"
      appsLabel="Apps"
      context={context}
    />
  )
}

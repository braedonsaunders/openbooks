import Link from 'next/link'
import { PageHeader } from '@openbooks/ui'
import { AppFrame } from './AppFrame'

/**
 * The three bodies this route can render, moved out of `page.tsx` so both
 * render paths share one implementation each.
 *
 * The two notice branches — "App not found" and "this app is disabled" — are
 * ONE component, not two. They differ only in their title and description
 * strings, which the loader resolves; the markup is identical, and two copies
 * that agree today are two copies that drift tomorrow.
 *
 * They are components rather than spec blocks because each is a PageHeader
 * followed by a back link with its own classes — a small composite, which is
 * exactly the shape the language says belongs in a component.
 */

export function AppNotice({
  title,
  description,
  backHref,
  backLabel,
}: {
  title: string
  description: string
  backHref: string
  backLabel: string
}) {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10">
      <PageHeader title={title} description={description} />
      <Link href={backHref} className="text-sm text-blue-600 hover:underline">
        {backLabel}
      </Link>
    </div>
  )
}

/**
 * The live runtime: a breadcrumb strip over a filling frame.
 *
 * `context` is plain data — app id/key/name and the caller's id, name and role
 * KEYS — assembled by the loader. It is not an `Authz`: the roles arrive as a
 * string array, and nothing here can be used to widen what the app may read.
 * The sandbox that consumes it is inside `AppFrame`.
 */
export function AppRuntimeChrome({
  appKey,
  appName,
  appsHref,
  appsLabel,
  context,
}: {
  appKey: string
  appName: string
  appsHref: string
  appsLabel: string
  context: Parameters<typeof AppFrame>[0]['context']
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b px-4 py-2">
        <Link href={appsHref} className="text-sm text-neutral-500 hover:underline">
          {appsLabel}
        </Link>
        <span className="text-neutral-300">/</span>
        <span className="text-sm font-medium">{appName}</span>
      </div>
      <div className="min-h-0 flex-1">
        <AppFrame appKey={appKey} context={context} />
      </div>
    </div>
  )
}

import { EmptyState, PageHeader } from '@openbooks/ui'
import { ListPageLayout } from './page-layout'

/** House route-boundary chrome for authenticated app error and not-found surfaces. */
export function RouteStateView({
  icon,
  title,
  description,
  action,
  state,
  footer,
}: {
  icon?: React.ReactNode
  title: string
  description?: string
  action?: React.ReactNode
  /** Optional line under the action (the error boundary quotes its request id here). */
  footer?: React.ReactNode
  /**
   * Machine-readable name for WHY this boundary is showing.
   *
   * The e2e route sweep needs to tell a page that rendered from a page that
   * crashed into this boundary, and both answer HTTP 200 with text in
   * `<main>`. Matching the visible copy would work today and break the first
   * time someone runs the suite in another locale, so the signal is an
   * attribute rather than a sentence. `forbidden` (permission refused) and
   * `feature-disabled` (existing route, switch off) keep those two honest
   * refusals distinct from a genuine `not-found`.
   */
  state?: 'error' | 'not-found' | 'forbidden' | 'feature-disabled'
}) {
  // One heading + one message: the PageHeader owns the copy; the body keeps
  // icon + recovery action so the boundary never reads twice (F-t05-005).
  return (
    <ListPageLayout header={<PageHeader title={title} description={description} />}>
      <div data-route-state={state}>
        <EmptyState icon={icon} action={action} />
        {footer ? (
          <p className="mt-4 text-center text-xs text-slate-500 dark:text-slate-400">{footer}</p>
        ) : null}
      </div>
    </ListPageLayout>
  )
}

/** Same chrome for routes outside the authenticated app shell (login, public links). */
export function RouteStateStandalone({
  icon,
  title,
  description,
  action,
}: {
  icon?: React.ReactNode
  title: string
  description?: string
  action?: React.ReactNode
}) {
  return (
    <div className="mx-auto flex min-h-full w-full max-w-screen-2xl flex-col p-4 sm:p-6">
      <PageHeader title={title} description={description} className="mb-8" />
      <div className="flex flex-1 items-center justify-center">
        <div className="w-full max-w-lg">
          <EmptyState icon={icon} action={action} />
        </div>
      </div>
    </div>
  )
}

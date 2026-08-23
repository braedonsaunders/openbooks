import { EmptyState, PageHeader } from '@openbooks/ui'
import { ListPageLayout } from './page-layout'

/** House route-boundary chrome for authenticated app error and not-found surfaces. */
export function RouteStateView({
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
    <ListPageLayout header={<PageHeader title={title} description={description} />}>
      <EmptyState icon={icon} title={title} description={description} action={action} />
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
          <EmptyState icon={icon} title={title} description={description} action={action} />
        </div>
      </div>
    </div>
  )
}

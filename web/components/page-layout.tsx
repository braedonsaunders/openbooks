import { cn } from '@openbooks/ui'
import { FadeInBody, FadeInHeader } from './page-layout-motion'

/**
 * Default page wrapper for content-driven pages (dashboards, forms, etc).
 * The whole body scrolls; header travels with it.
 *
 * Use ListPageLayout for tabular pages and DetailPageLayout for entities.
 */
export function PageContainer({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className="app-scroll flex-1 overflow-y-auto">
      <FadeInBody className={cn('mx-auto w-full max-w-screen-2xl p-4 sm:p-6', className)}>
        {children}
      </FadeInBody>
    </div>
  )
}

/**
 * List page layout — header (title/actions/search/filter chips) is sticky;
 * only the table area scrolls. The header fades in on mount; the body
 * fades in slightly behind it.
 *
 *   <ListPageLayout
 *     header={...}        // PageHeader, search/filter row, etc
 *     children={tableElement}
 *   />
 */
export function ListPageLayout({
  header,
  children,
  className,
}: {
  header: React.ReactNode
  children: React.ReactNode
  /**
   * Overrides for the body wrapper — pass e.g. `flex h-full min-h-0 flex-col`
   * for app-feel pages that fit the viewport and scroll only inside panels.
   */
  className?: string
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-slate-200 bg-white px-3 pt-3 pb-2.5 sm:px-6 sm:pt-4 sm:pb-3 dark:border-slate-800 dark:bg-slate-900">
        <FadeInHeader className="mx-auto max-w-screen-2xl space-y-2 sm:space-y-2.5">
          {header}
        </FadeInHeader>
      </div>
      <div className="app-scroll min-h-0 flex-1 overflow-y-auto">
        <FadeInBody className={cn('mx-auto max-w-screen-2xl p-3 sm:p-6', className)}>
          {children}
        </FadeInBody>
      </div>
    </div>
  )
}

/**
 * Detail page layout — fixed header (DetailHeader + optional alerts) and a
 * horizontal subtab strip; tab content fills the remaining space and scrolls
 * internally.
 *
 *   <DetailPageLayout
 *     header={<DetailHeader … />}
 *     alerts={<Alert … />}
 *     subtabs={<TabNav … />}
 *     children={activeTabContent}
 *   />
 */
export function DetailPageLayout({
  header,
  alerts,
  subtabs,
  children,
  className,
}: {
  header: React.ReactNode
  alerts?: React.ReactNode
  subtabs?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <FadeInHeader className="mx-auto max-w-screen-2xl px-3 pt-3 sm:px-6 sm:pt-5">
          {header}
          {alerts ? <div className="mt-2.5 space-y-2 sm:mt-3">{alerts}</div> : null}
          {subtabs ? <div className="mt-2.5 sm:mt-4">{subtabs}</div> : null}
        </FadeInHeader>
      </div>
      <div className="app-scroll min-h-0 flex-1 overflow-y-auto">
        <FadeInBody className={cn('mx-auto max-w-screen-2xl p-3 sm:p-6', className)}>
          {children}
        </FadeInBody>
      </div>
    </div>
  )
}

/**
 * Three-row "wizard" layout for forms — sticky header (title/progress),
 * scrollable body (the active step), sticky footer (Back/Next/Submit).
 */
export function WizardLayout({
  header,
  footer,
  children,
  className,
  wide = false,
}: {
  header: React.ReactNode
  // Optional: when omitted, no footer bar renders (the body runs to the bottom)
  // — a read-only record view reads as a DetailPageLayout, not a wizard.
  footer?: React.ReactNode
  children: React.ReactNode
  className?: string
  // Full-width content column (matches DetailPageLayout). Used by read-only
  // record views; editable forms stay in the narrower, focused column.
  wide?: boolean
}) {
  const maxW = wide ? 'max-w-screen-2xl' : 'max-w-3xl'
  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      <div className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <FadeInHeader className={cn('mx-auto px-4 py-4 sm:px-6', maxW)}>{header}</FadeInHeader>
      </div>
      <div className="app-scroll min-h-0 flex-1 overflow-y-auto">
        <FadeInBody className={cn('mx-auto space-y-5 p-4 sm:p-6', maxW)}>{children}</FadeInBody>
      </div>
      {footer != null ? (
        <div className="border-t border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <div className={cn('ff-footer mx-auto px-4 py-3 sm:px-6', maxW)}>{footer}</div>
        </div>
      ) : null}
    </div>
  )
}

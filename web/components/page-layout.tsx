'use client'

import { useContext } from 'react'
import { cn, PageHeaderNavigationProvider, PagePresentationContext } from '@openbooks/ui'
import { FadeInBody, FadeInHeader } from './page-layout-motion'
import { PageViewTabs } from './module-home/view-tabs'

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
  const section = useContext(PagePresentationContext) === 'section'
  if (section) return <FadeInBody className={className}>{children}</FadeInBody>
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
 * fades in slightly behind it. When a route layout provides sibling view
 * tabs (see module-home/view-tabs), the header provider places the shared
 * switch in PageHeader's action rail, consistently across sibling pages.
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
  contained = false,
}: {
  header: React.ReactNode
  children: React.ReactNode
  /**
   * Overrides for the body wrapper — pass e.g. `flex h-full min-h-0 flex-col`
   * for app-feel pages that fit the viewport and scroll only inside panels.
   */
  className?: string
  /** Fill the available workspace; each work area owns its scrolling. */
  contained?: boolean
}) {
  const section = useContext(PagePresentationContext) === 'section'
  if (section) {
    return (
      <div data-page-layout className="space-y-4">
        <FadeInHeader>{header}</FadeInHeader>
        <FadeInBody className={className}>{children}</FadeInBody>
      </div>
    )
  }
  return (
    <div data-page-layout className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-slate-200 bg-white px-3 pt-3 pb-2.5 sm:px-6 sm:pt-4 sm:pb-3 dark:border-slate-800 dark:bg-slate-900">
        <FadeInHeader className={cn('space-y-2 sm:space-y-2.5', !contained && 'mx-auto max-w-screen-2xl')}>
          <PageHeaderNavigationProvider navigation={<PageViewTabs />}>{header}</PageHeaderNavigationProvider>
        </FadeInHeader>
      </div>
      <div className={cn('min-h-0 flex-1', contained ? 'overflow-hidden' : 'app-scroll overflow-y-auto')}>
        <FadeInBody className={cn('p-3 sm:p-6', contained ? 'flex min-h-0 flex-col overflow-hidden' : 'mx-auto max-w-screen-2xl', className)}>
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
    <div data-page-layout className="flex h-full min-h-0 flex-col">
      <div className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <FadeInHeader className="mx-auto max-w-screen-2xl px-3 pt-3 sm:px-6 sm:pt-5">
          <PageHeaderNavigationProvider navigation={<PageViewTabs />}>{header}</PageHeaderNavigationProvider>
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
  steps,
  currentStep,
  progressLabel,
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
  /** Ordered, read-only progress; step transitions remain owned by the form. */
  steps?: readonly { key: string; label: string }[]
  currentStep?: string
  progressLabel?: string
}) {
  const section = useContext(PagePresentationContext) === 'section'
  const progress = steps ? (
    <ol aria-label={progressLabel} className="flex gap-2">
      {steps.map((item, index) => {
        const activeIndex = steps.findIndex((candidate) => candidate.key === currentStep)
        const active = item.key === currentStep
        const complete = activeIndex > index
        return (
          <li key={item.key} aria-current={active ? 'step' : undefined}
            className={cn('flex min-w-0 flex-1 flex-col gap-2 rounded-lg border px-2 py-2 text-xs sm:flex-row sm:items-center sm:px-3 sm:text-sm',
              active ? 'border-teal-300 bg-teal-50 font-medium text-teal-800 dark:border-teal-800 dark:bg-teal-950/40 dark:text-teal-300' : 'border-slate-200 text-slate-500 dark:border-slate-800 dark:text-slate-400')}>
            <span aria-hidden="true" className={cn('grid h-5 w-5 shrink-0 place-items-center rounded-full text-xs',
              active || complete ? 'bg-teal-600 text-white' : 'bg-slate-100 dark:bg-slate-800')}>
              {complete ? '✓' : index + 1}
            </span>
            <span>{item.label}</span>
          </li>
        )
      })}
    </ol>
  ) : null
  if (section) {
    return (
      <div className={cn('space-y-5', className)}>
        <FadeInHeader className="space-y-4">{header}{progress}</FadeInHeader>
        <FadeInBody className="space-y-5">{children}</FadeInBody>
        {footer != null ? <div className="ff-footer border-t border-slate-200 pt-4 dark:border-slate-800">{footer}</div> : null}
      </div>
    )
  }
  const maxW = wide ? 'max-w-screen-2xl' : 'max-w-3xl'
  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      <div className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <FadeInHeader className={cn('mx-auto space-y-4 px-4 py-4 sm:px-6', maxW)}>
          {header}
          {progress}
        </FadeInHeader>
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

'use client'

import Link from 'next/link'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useViewerFormat } from '@/lib/viewer-format'
import { mergeHref } from '@/lib/list-params'
import { isReportOverlayParam } from '@/lib/report-overlay'
import { OverlayLink } from './overlay-link'
import { paginationWindow } from '../lib/pagination-window'
import { useReportOverlayOptional } from './navigation-provider'

export function Pagination({
  basePath,
  currentParams,
  total,
  hasMore = false,
  loadedCount,
  showRange = true,
  page,
  perPage,
  pageParamKey = 'page',
  onPageChange,
  compact = false,
}: {
  basePath: string
  currentParams: Record<string, string | string[] | undefined>
  total: number | null
  /** A bounded reader may know only whether another page exists. */
  hasMore?: boolean
  loadedCount?: number
  /** Filtered subsets of a source page retain its cursor without asserting a contiguous range. */
  showRange?: boolean
  page: number
  perPage: number
  /** URL param that carries the page number. Sub-tables pass a prefixed key. */
  pageParamKey?: string
  /** Keep pagination local for a palette or embedded editor. */
  onPageChange?: (page: number) => void
  compact?: boolean
}) {
  const t = useTranslations('ui.pagination')
  const { number } = useViewerFormat()
  const tCommon = useTranslations('common')
  const overlay = useReportOverlayOptional()
  const overlayNav = Boolean(overlay && isReportOverlayParam(pageParamKey))
  const {unknownTotal,visibleCount,pageCount,from,to,isOutOfRange} = paginationWindow({total,page,perPage,loadedCount,hasMore})

  const prevHref = mergeHref(basePath, currentParams, {
    [pageParamKey]: page > 1 ? page - 1 : 1,
  })
  const nextHref = mergeHref(basePath, currentParams, {
    [pageParamKey]: Math.min(pageCount, page + 1),
  })
  const lastPageHref = mergeHref(basePath, currentParams, {
    [pageParamKey]: pageCount,
  })

  return (
    <div className="flex items-center justify-between gap-2 px-3 py-2 text-sm text-slate-600 dark:text-slate-300">
      <span>
        {isOutOfRange
          ? t('outOfRange', { page: number(page) })
          : visibleCount === 0
            ? tCommon('feedback.noResults')
            : unknownTotal ? showRange ? t('showingLoaded', {from:number(from),to:number(to)}) : t('pageOnly',{page}) : t.rich('showing', {
                from: number(from),
                to: number(to),
                total: number(total!),
                strong: (chunks) => (
                  <strong className="font-medium text-slate-900 dark:text-slate-100">
                    {chunks}
                  </strong>
                ),
              })}
      </span>
      {isOutOfRange ? (
        <PageButton
          href={lastPageHref}
          onClick={onPageChange ? () => onPageChange(pageCount) : undefined}
          overlayNav={overlayNav}
          aria-label={t('goToLastPageAria', { page: number(pageCount) })}
        >
          <ChevronLeft size={14} />
          {t('goToPage', { page: number(pageCount) })}
        </PageButton>
      ) : pageCount > 1 || unknownTotal && hasMore ? (
        <div className="flex items-center gap-1">
          <PageButton href={prevHref} onClick={onPageChange ? () => onPageChange(Math.max(1, page - 1)) : undefined} overlayNav={overlayNav} disabled={page <= 1} aria-label={t('previousPageAria')}>
            <ChevronLeft size={14} />
            {!compact && t('prev')}
          </PageButton>
          {!compact && <span className="px-2 text-slate-500 dark:text-slate-400">
            {unknownTotal ? t('pageOnly', {page}) : t('pageOf', { page, pages: pageCount })}
          </span>}
          <PageButton href={nextHref} onClick={onPageChange ? () => onPageChange(Math.min(pageCount, page + 1)) : undefined} overlayNav={overlayNav} disabled={page >= pageCount} aria-label={t('nextPageAria')}>
            {!compact && tCommon('actions.next')}
            <ChevronRight size={14} />
          </PageButton>
        </div>
      ) : null}
    </div>
  )
}

function PageButton({
  href,
  disabled,
  overlayNav,
  children,
  onClick,
  ...rest
}: {
  href: string
  disabled?: boolean
  overlayNav?: boolean
  children: React.ReactNode
  onClick?: () => void
} & Omit<React.HTMLAttributes<HTMLAnchorElement>, 'onClick'>) {
  const className = "inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-slate-800/60"
  if (disabled) {
    return (
      <span
        className="inline-flex cursor-not-allowed items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500"
        {...(rest as object)}
      >
        {children}
      </span>
    )
  }
  if (onClick) return <button type="button" className={className} onClick={onClick} {...(rest as object)}>{children}</button>
  if (overlayNav) {
    return (
      <OverlayLink href={href} className={className} {...(rest as object)}>
        {children}
      </OverlayLink>
    )
  }
  return (
    <Link
      href={href}
      className={className}
      {...(rest as object)}
    >
      {children}
    </Link>
  )
}

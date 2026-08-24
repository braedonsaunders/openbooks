import Link from 'next/link'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { mergeHref } from '@/lib/list-params'

export function Pagination({
  basePath,
  currentParams,
  total,
  page,
  perPage,
  pageParamKey = 'page',
}: {
  basePath: string
  currentParams: Record<string, string | string[] | undefined>
  total: number
  page: number
  perPage: number
  /** URL param that carries the page number. Sub-tables pass a prefixed key. */
  pageParamKey?: string
}) {
  const t = useTranslations('ui.pagination')
  const tCommon = useTranslations('common')
  const pageCount = Math.max(1, Math.ceil(total / perPage))
  const isOutOfRange = total > 0 && page > pageCount
  const from = total === 0 ? 0 : (page - 1) * perPage + 1
  const to = Math.min(total, page * perPage)

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
          ? t('outOfRange', { page: page.toLocaleString() })
          : total === 0
            ? tCommon('feedback.noResults')
            : t.rich('showing', {
                from: from.toLocaleString(),
                to: to.toLocaleString(),
                total: total.toLocaleString(),
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
          aria-label={t('goToLastPageAria', { page: pageCount.toLocaleString() })}
        >
          <ChevronLeft size={14} />
          {t('goToPage', { page: pageCount.toLocaleString() })}
        </PageButton>
      ) : pageCount > 1 ? (
        <div className="flex items-center gap-1">
          <PageButton href={prevHref} disabled={page <= 1} aria-label={t('previousPageAria')}>
            <ChevronLeft size={14} />
            {t('prev')}
          </PageButton>
          <span className="px-2 text-slate-500 dark:text-slate-400">
            {t('pageOf', { page, pages: pageCount })}
          </span>
          <PageButton href={nextHref} disabled={page >= pageCount} aria-label={t('nextPageAria')}>
            {tCommon('actions.next')}
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
  children,
  ...rest
}: {
  href: string
  disabled?: boolean
  children: React.ReactNode
} & React.HTMLAttributes<HTMLAnchorElement>) {
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
  return (
    <Link
      href={(href)}
      className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-slate-800/60"
      {...(rest as object)}
    >
      {children}
    </Link>
  )
}

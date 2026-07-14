// UiLink rather than a bare <a>: back-links are in-app routes, and a plain
// anchor forces a full document reload — which replays the boot splash and
// refetches the whole shell on every record → list hop. The app injects its
// client-side Link via UiLinkProvider (see link-context.tsx).
import { UiBackLink } from './link-context'
import { cn } from './utils'

export function PageHeader({
  title,
  description,
  actions,
  back,
  className,
}: {
  title: string
  description?: string
  actions?: React.ReactNode
  back?: { href: string; label: string }
  className?: string
}) {
  return (
    <div className={cn('space-y-2', className)}>
      {back ? (
        <UiBackLink
          href={back.href}
          label={back.label}
          className="text-xs text-slate-500 hover:text-teal-700 dark:text-slate-400 dark:hover:text-teal-300"
        />
      ) : null}
      {/* One row at every breakpoint: title on the left (truncates to make
          room), actions pinned right. Phones drop the description to keep the
          header to a single line; sm+ shows it below and bottom-aligns the
          actions. */}
      <header className="flex items-center justify-between gap-3 sm:items-end sm:gap-4">
        <div className="min-w-0 space-y-1">
          <h1 className="truncate text-xl font-semibold text-slate-900 sm:text-2xl dark:text-slate-100">
            {title}
          </h1>
          {description ? (
            <p className="hidden text-sm text-slate-500 sm:block dark:text-slate-400">
              {description}
            </p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">{actions}</div>
        ) : null}
      </header>
    </div>
  )
}

export function DetailHeader({
  back,
  title,
  subtitle,
  badge,
  actions,
}: {
  back?: { href: string; label: string }
  title: string
  subtitle?: string
  badge?: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <header className="space-y-2">
      {back ? (
        <UiBackLink
          href={back.href}
          label={back.label}
          className="text-sm text-teal-700 hover:underline dark:text-teal-300"
        />
      ) : null}
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
          <h1 className="text-xl font-semibold text-slate-900 sm:truncate sm:text-2xl dark:text-slate-100">
            {title}
          </h1>
          {badge}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {subtitle ? <p className="text-sm text-slate-500 dark:text-slate-400">{subtitle}</p> : null}
    </header>
  )
}

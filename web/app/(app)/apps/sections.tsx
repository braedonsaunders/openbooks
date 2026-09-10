import Link from 'next/link'
import { ArrowUpRight, BookOpen, Boxes, Library } from 'lucide-react'
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@openbooks/ui'
import { NavIcon } from '@/components/sidebar-nav'

/**
 * Shared presentational cells for /apps, used by the native page and the
 * ViewSpec path alike so the two renders stay byte-identical.
 */

/** One installed-app card: the link wrapping it carries the aria-label. */
export function AppLauncherCard({
  href,
  ariaLabel,
  iconKey,
  name,
  versionLine,
  description,
  openLabel,
}: {
  href: string
  ariaLabel: string
  iconKey: string
  name: string
  versionLine: string
  description: string
  openLabel: string
}) {
  return (
    <Link href={href} aria-label={ariaLabel}>
      <Card interactive className="h-full">
        <CardHeader className="flex-row items-start gap-3 p-4 pb-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300">
            <NavIcon iconKey={iconKey} size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <CardTitle className="truncate text-base">{name}</CardTitle>
            <p className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">{versionLine}</p>
          </div>
        </CardHeader>
        <CardContent className="flex h-[calc(100%-4rem)] flex-col px-4 pb-4">
          <CardDescription className="line-clamp-2 min-h-10">{description}</CardDescription>
          <span className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-teal-700 dark:text-teal-300">
            {openLabel} <ArrowUpRight size={14} aria-hidden />
          </span>
        </CardContent>
      </Card>
    </Link>
  )
}

/**
 * The empty/no-results medallion. The native page renders it inline in a
 * plain span, but the badge span is its own named component so the registry
 * entry stays a one-liner.
 */
export function AppsEmptyIcon() {
  return (
    <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
      <Boxes size={21} aria-hidden />
    </span>
  )
}

/**
 * Header and empty-state action button. The native page renders two shapes:
 * an outline small docs/library action in the header and a solid small
 * library CTA on the virgin-tenant empty note. One component with the exact
 * variant/size/icon props the page uses — never the existing
 * `docs-link-button` (14px icon) or `apps-library-button` (outline-only):
 * both are byte-different from at least one of these shapes.
 */
export function AppsLauncherButton({
  href,
  label,
  icon,
  variant,
  size,
  className,
}: {
  href: string
  label: string
  icon: 'book' | 'library'
  variant?: 'outline'
  size?: 'sm'
  className?: string
}) {
  const Icon = icon === 'book' ? BookOpen : Library
  return (
    <Button variant={variant} size={size} asChild className={className}>
      <Link href={href as never}>
        <Icon size={15} /> {label}
      </Link>
    </Button>
  )
}

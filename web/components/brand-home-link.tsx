'use client'

// The brand lockup in the shell header/rail, wrapped as a link home to the
// dashboard — the conventional "click the logo to get home" affordance.

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { cn } from '@openbooks/ui'
import { Logo } from './brand-logo'

export function BrandHomeLink({ className }: { className?: string }) {
  const t = useTranslations('shell.brand')
  return (
    <Link
      href="/"
      aria-label={t('home')}
      title={t('home')}
      className={cn(
        'inline-flex shrink-0 items-center rounded-md outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-teal-500',
        className,
      )}
    >
      <Logo className="h-7 w-auto" />
    </Link>
  )
}

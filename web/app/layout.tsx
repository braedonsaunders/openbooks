import './globals.css'
import type { Metadata, Viewport } from 'next'
import Script from 'next/script'
import { NextIntlClientProvider } from 'next-intl'
import { getLocale, getMessages, getTranslations } from 'next-intl/server'
import { Toaster } from 'sonner'
import { AppLinkProvider } from '../components/app-link-provider'
import { SplashScreen } from '../components/brand-splash'
import { ConfirmRoot } from '../lib/confirm'
import { PromptRoot } from '../lib/prompt'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('shell')
  return {
    title: { default: 'openbooks', template: '%s · openbooks' },
    description: t('meta.description'),
    applicationName: 'openbooks',
  }
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
  themeColor: '#0f766e',
}

export const dynamic = 'force-dynamic'

// Runs before first paint. Two concerns, one script so there's a single inline
// <script> in the tree:
//   • theme — apply .dark up front so a dark-mode user never sees a white flash.
//   • nav-internal — flag document loads that came from within the app itself
//     (e.g. opening an in-app link in a new tab). SplashScreen reads this to skip
//     the brand intro for those — you're already inside, no reveal needed. Direct
//     visits, bookmarks, and external links have no same-origin referrer and
//     still get the splash. CSS hides the splash while the flag is set so nothing
//     flashes before SplashScreen clears it on mount.
const HEAD_INIT = `(function(){try{var t=localStorage.getItem('theme')||'system';var m=window.matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.classList.toggle('dark',t==='dark'||(t==='system'&&m));}catch(e){}try{var r=document.referrer;if(r&&new URL(r).origin===location.origin){document.documentElement.classList.add('nav-internal');}}catch(e){}})();`

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Locale: users.locale ?? orgs.settings.defaultLocale ?? 'en' (i18n/request.ts).
  const [locale, messages] = await Promise.all([getLocale(), getMessages()])
  return (
    <html lang={locale} className="h-full" data-application-name="openbooks" suppressHydrationWarning>
      <head>
        <Script
          id="openbooks-head-init"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: HEAD_INIT }}
        />
      </head>
      <body className="h-full overflow-hidden bg-slate-50 text-slate-900 antialiased dark:bg-slate-950 dark:text-slate-100">
        <NextIntlClientProvider locale={locale} messages={messages}>
          <AppLinkProvider>{children}</AppLinkProvider>
          <SplashScreen />
          <Toaster richColors position="top-right" />
          {/* confirmDialog()'s host — without it every confirm-gated action hangs. */}
          <ConfirmRoot />
          {/* promptDialog()'s host (rename, etc.). */}
          <PromptRoot />
        </NextIntlClientProvider>
      </body>
    </html>
  )
}

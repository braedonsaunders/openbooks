import './globals.css'
import type { Metadata, Viewport } from 'next'
import { Toaster } from 'sonner'
import { AppLinkProvider } from '../components/app-link-provider'

export const metadata: Metadata = {
  title: { default: 'openbooks', template: '%s · openbooks' },
  description: 'The open business suite. Run on open books.',
  applicationName: 'openbooks',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
  themeColor: '#0f766e',
}

export const dynamic = 'force-dynamic'

// Applied before first paint so a dark-mode user never sees a white flash.
const THEME_INIT = `(function(){try{var t=localStorage.getItem('theme')||'system';var m=window.matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.classList.toggle('dark',t==='dark'||(t==='system'&&m));}catch(e){}})();`

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full" suppressHydrationWarning>
      <head>
        <script suppressHydrationWarning dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body className="h-full overflow-hidden bg-slate-50 text-slate-900 antialiased dark:bg-slate-950 dark:text-slate-100">
        <AppLinkProvider>{children}</AppLinkProvider>
        <Toaster richColors position="top-right" />
      </body>
    </html>
  )
}

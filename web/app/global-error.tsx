'use client'

import { useEffect } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button, EmptyState } from '@openbooks/ui'
import shell from '@/messages/en/shell.json'

/** Catches root-layout failures; must define its own document (no app providers). */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const t = shell.routeState

  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <html lang="en">
      <body className="h-full bg-slate-50 text-slate-900 antialiased dark:bg-slate-950 dark:text-slate-100">
        <div className="flex min-h-screen items-center justify-center p-6">
          <div className="w-full max-w-lg">
            <EmptyState
              icon={<AlertTriangle />}
              title={t.errorTitle}
              description={t.errorDescription}
              action={<Button onClick={reset}>Retry</Button>}
            />
          </div>
        </div>
      </body>
    </html>
  )
}

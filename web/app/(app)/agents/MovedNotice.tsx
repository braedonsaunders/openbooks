'use client'

import { useState } from 'react'
import { Alert, AlertDescription, AlertTitle, Button } from '@openbooks/ui'

/**
 * Dismissible landing notice for retired routes that redirect here with
 * context (F-t13-007: /continuous-close → /agents?from=continuous-close).
 * Loader-resolved strings only — no catalog access, so the spec places it
 * like every other widget. Dismissal is session-local; the redirect explains
 * itself once per landing.
 */
export function MovedNotice({
  title,
  description,
  dismissLabel,
}: {
  title: string
  description: string
  dismissLabel: string
}) {
  const [visible, setVisible] = useState(true)
  if (!visible) return null
  return (
    <Alert variant="info" role="status">
      <div className="flex items-start justify-between gap-4">
        <div>
          <AlertTitle>{title}</AlertTitle>
          <AlertDescription>{description}</AlertDescription>
        </div>
        <Button variant="outline" size="sm" onClick={() => setVisible(false)} className="shrink-0">
          {dismissLabel}
        </Button>
      </div>
    </Alert>
  )
}

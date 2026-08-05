'use client'

// Submit button that gates a server-action <form> behind an animated
// confirmation modal (confirmDialog). Shared across every module plus the admin
// and platform user surfaces so destructive lifecycle actions (remove, revoke,
// delete, grant) look and behave identically.
//
// confirmDialog is async, so we can't gate the native submit inline. Instead we
// always preventDefault, then re-submit the form via requestSubmit(button) once
// the user confirms — which preserves the button's own formAction/name/value.

import type { ReactNode } from 'react'
import { Button, type ButtonProps } from '@openbooks/ui'
import { confirmDialog, type ConfirmTone } from '@/lib/confirm'

export function ConfirmButton({
  children,
  message,
  tone,
  type = 'submit',
  variant = 'outline',
  ...props
}: ButtonProps & { children: ReactNode; message: string; tone?: ConfirmTone }) {
  // Destructive-styled buttons get the red warning modal automatically.
  const resolvedTone: ConfirmTone = tone ?? (variant === 'destructive' ? 'danger' : 'default')
  return (
    <Button
      {...props}
      type={type}
      variant={variant}
      onClick={(e) => {
        e.preventDefault()
        const btn = e.currentTarget
        void confirmDialog({ message, tone: resolvedTone }).then((ok) => {
          if (ok) btn.form?.requestSubmit(btn)
        })
      }}
    >
      {children}
    </Button>
  )
}

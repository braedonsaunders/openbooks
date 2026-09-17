'use client'

import { useAction } from '@braedonsaunders/appkit-errors/react'
import { toast } from 'sonner'

/**
 * The one action-error path for this app. Every drawer, panel and row that
 * performs a user action runs it through here so a server refusal can never
 * go silent: the refusal pins beside the record until the next action (via
 * the package's `useAction`) AND fires a toast, with no dismiss button, and
 * the busy flag always releases through the package's `finally`.
 *
 * Copy stays with the caller: pass the already-localized `fallbackMessage`
 * (a catalog key through `t()`) at each `execute` site. The server's own
 * reason renders verbatim when it is usable; the fallback covers transport
 * failures and unusable bodies.
 */
export function useAppAction() {
  return useAction({
    notifyError: (message) => toast.error(message),
    notifySuccess: (message) => toast.success(message),
  })
}

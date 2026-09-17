'use client'

import { useCallback } from 'react'
import { ActionError } from '@braedonsaunders/appkit-errors'
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
 *
 * Client-side blocks (script gates, up-front proofs) go through `refuse` so
 * they pin and toast exactly like a server refusal instead of inventing a
 * second, quieter presentation.
 */
export function useAppAction() {
  const { busy, refusal, execute, clearRefusal, setRefusal } = useAction({
    notifyError: (message) => toast.error(message),
    notifySuccess: (message) => toast.success(message),
  })
  const refuse = useCallback(
    (serverMessage: string | null | undefined, fallbackMessage: string) => {
      const error = new ActionError({ kind: 'refused', serverMessage: serverMessage ?? null })
      setRefusal(error)
      toast.error(error.displayMessage(fallbackMessage))
    },
    [setRefusal],
  )
  return { busy, refusal, execute, clearRefusal, refuse }
}

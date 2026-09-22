'use client'

import { useCallback, useRef } from 'react'
import { ActionError, type ActionResult } from '@braedonsaunders/appkit-errors'
import { useAction, type ExecuteOptions } from '@braedonsaunders/appkit-errors/react'
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
 * One drawer-level alert cannot carry a per-action fallback: when a refusal
 * names no reason, the pin would render whatever fallback the alert was
 * given — the wrong copy beside any action but one. So `execute` fills a
 * blank refusal message with the call-site fallback before the package pins
 * and notifies: pin and toast always agree, and call sites that need
 * translated copy instead of a raw code set it explicitly as the refusal's
 * server message (which always wins).
 *
 * Client-side blocks (script gates, up-front proofs) go through `refuse` so
 * they pin and toast exactly like a server refusal instead of inventing a
 * second, quieter presentation.
 */
export function useAppAction() {
  const notifyError = useCallback((message: string) => toast.error(message), [])
  const notifySuccess = useCallback((message: string) => toast.success(message), [])
  const { busy, refusal, execute: baseExecute, clearRefusal, setRefusal } = useAction({ notifyError, notifySuccess })
  const execute = useCallback(
    <T,>(task: () => Promise<ActionResult<T>>, options: ExecuteOptions<T>): Promise<boolean> =>
      baseExecute(async () => {
        const result = await task()
        if (!result.ok && (result.error.serverMessage == null || result.error.serverMessage.trim() === '')) {
          return {
            ok: false,
            error: new ActionError({
              kind: result.error.kind,
              status: result.error.status,
              code: result.error.code,
              issues: result.error.issues,
              serverMessage: options.fallbackMessage,
              aborted: result.error.aborted,
              detail: result.error.detail,
            }),
          }
        }
        return result
      }, options),
    [baseExecute],
  )
  const refuse = useCallback(
    (serverMessage: string | null | undefined, fallbackMessage: string) => {
      const error = new ActionError({ kind: 'refused', serverMessage: serverMessage ?? null })
      setRefusal(error)
      toast.error(error.displayMessage(fallbackMessage))
    },
    [setRefusal],
  )
  /**
   * Synchronous re-entry guard for actions with a multi-await preamble
   * before `execute` sets busy (client-script gates, confirm prompts):
   * wrap the whole action — `const save = runExclusive(async () => {...})`
   * — so the flag flips in the same tick as the click and a second click
   * lands on a set flag instead of racing the preamble and sending the
   * write twice with the same revision. The wrapper returns false for a
   * dropped run. Do not nest it: a guarded action that triggers another
   * guarded action on the same hook would drop the inner one, so
   * follow-ups ride plain `execute` inside `onOk`.
   */
  const exclusive = useRef(false)
  const runExclusive = useCallback(
    <T extends unknown[]>(action: (...args: T) => Promise<void>): ((...args: T) => Promise<boolean>) => {
      return async (...args) => {
        if (exclusive.current) return false
        exclusive.current = true
        try {
          await action(...args)
          return true
        } finally {
          exclusive.current = false
        }
      }
    },
    [],
  )
  return { busy, refusal, execute, clearRefusal, refuse, runExclusive }
}

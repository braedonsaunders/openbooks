'use client'

import {
  ActionError,
  classifiedError,
  readActionResult,
  transportError,
  type ActionResult,
} from '@braedonsaunders/appkit-errors'
import { readApiErrorMessage } from '@/lib/api-error'

/**
 * One request to a channel order route, shaped for useAppAction. The status
 * is checked before the body is read: a refusal carries the server's `error`
 * AND its `remedy` (readApiErrorMessage joins them), so the operator reads
 * what went wrong and what to do about it.
 */
export async function channelRequest<T>(
  url: string,
  init: { method: 'GET' | 'POST' | 'PATCH'; body?: unknown },
  fallbackMessage: string,
): Promise<ActionResult<T>> {
  let res: Response
  try {
    res = await fetch(url, {
      method: init.method,
      cache: 'no-store',
      headers: init.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
  } catch (error) {
    return { ok: false, error: transportError(error instanceof Error ? error.message : String(error)) }
  }
  if (!res.ok) {
    const message = await readApiErrorMessage(res, fallbackMessage)
    return {
      ok: false,
      error: new ActionError({ kind: classifiedError(res.status).kind, status: res.status, serverMessage: message }),
    }
  }
  return readActionResult<T>(res)
}

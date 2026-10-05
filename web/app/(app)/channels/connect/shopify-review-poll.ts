import { apiJson, ApiResponseError } from '../../../../lib/api-error'

/** Poll only a pending approval; refusals and unreadable responses reach the caller. */
export async function waitForShopifyReview<T extends { channel: { status: string } }>(
  id: string,
  options: { signal: AbortSignal; failureMessage: string; timeoutMessage: string; intervalMs?: number; timeoutMs?: number },
): Promise<T> {
  const controller = new AbortController()
  const signal = AbortSignal.any([options.signal, controller.signal])
  const timeout = setTimeout(() => controller.abort(new ApiResponseError(options.timeoutMessage, 408)), options.timeoutMs ?? 300_000)
  try {
    for (;;) {
      signal.throwIfAborted()
      const next = await apiJson<T>(`/api/channels/${id}/review`, { signal }, options.failureMessage)
      signal.throwIfAborted()
      if (next.channel.status !== 'draft') return next
      await new Promise<void>((resolve, reject) => {
        const finish = () => { signal.removeEventListener('abort', abort); resolve() }
        const timer = setTimeout(finish, options.intervalMs ?? 3000)
        const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason) }
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      })
    }
  } catch (error) {
    if (signal.aborted) throw signal.reason
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

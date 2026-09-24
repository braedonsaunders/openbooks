'use client'

import { useEffect, useRef } from 'react'
import { useTranslations } from 'next-intl'
import { readApiErrorMessage } from '@/lib/api-error'
import {
  makeBridgeResult,
  parseBridgeRequest,
  isBridgeMethod,
  type BridgeContext,
} from '@/lib/apps/bridge'

/**
 * AppFrame — the host side of an installed App's separately served document.
 * assembles a single self-contained HTML document (assets inlined as data:
 * URLs, CSP + bridge SDK injected), and renders it in an OPAQUE-ORIGIN
 * sandboxed iframe (sandbox="allow-scripts", deliberately no allow-same-origin).
 * The App therefore runs with no cookies, no parent-DOM access, and no network
 * of its own — its only capability is bridge calls, which this component relays
 * to the permission-checked /api/apps/<key>/bridge route on the user's behalf.
 */

export function AppFrame({
  appKey,
  context,
  previewDraftId,
}: {
  appKey: string
  context: BridgeContext
  previewDraftId?: string
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const t = useTranslations('apps')
  // Relay bridge calls from THIS iframe to the server, post results back.
  useEffect(() => {
    async function onMessage(e: MessageEvent) {
      const iframe = iframeRef.current
      if (!iframe || e.source !== iframe.contentWindow) return // only our sandbox
      const req = parseBridgeRequest(e.data)
      if (!req) return
      const post = (ok: boolean, payload: unknown) =>
        iframe.contentWindow?.postMessage(makeBridgeResult(req.id, ok, payload), '*')

      if (previewDraftId) { post(false, t('bridge.previewDraftRefusal')); return }
      if (!isBridgeMethod(req.method)) {
        post(false, t('bridge.unknownMethod', { method: req.method }))
        return
      }
      try {
        const res = await fetch(`/api/apps/${encodeURIComponent(appKey)}/bridge`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ method: req.method, payload: req.payload, versionId: context.app.versionId, invocationKey: req.invocationKey }),
        })
        // The status is checked before the body is parsed: a non-JSON error
        // body must surface the failure, never a SyntaxError from res.json()
        // and never an empty object that hides the server's refusal.
        if (!res.ok) {
          post(false, await readApiErrorMessage(res, t('bridge.callFailed')))
          return
        }
        // The success body is parsed defensively too: a 200 with a non-JSON
        // or shapeless body refuses by name instead of posting success with
        // an empty result (or a SyntaxError string).
        const json = (await res.json().catch(() => null)) as {
          ok?: unknown
          error?: unknown
          result?: unknown
        } | null
        if (json?.ok === false) {
          post(
            false,
            typeof json?.error === 'string' && json.error.trim() !== ''
              ? json.error
              : t('bridge.callFailedWithStatus', { status: res.status }),
          )
        } else if (!json || typeof json !== 'object' || !('result' in json)) {
          post(false, t('bridge.callFailedWithStatus', { status: res.status }))
        } else post(true, json.result)
      } catch {
        // A fetch rejection has no server refusal to surface; the named,
        // translated failure beats the browser's technical TypeError string.
        post(false, t('bridge.callFailed'))
      }
    }
    window.addEventListener('message', onMessage)
    // Start the document only after the bridge listener exists. Warm responses
    // may otherwise execute before React hydrates and lose the first request.
    if (iframeRef.current) iframeRef.current.src = `/api/apps/${encodeURIComponent(appKey)}/sandbox${previewDraftId ? `?draft=${encodeURIComponent(previewDraftId)}` : context.app.versionId ? `?versionId=${encodeURIComponent(context.app.versionId)}` : ''}`
    return () => window.removeEventListener('message', onMessage)
    // The translator is read inside the relay on purpose: re-subscribing (and
    // re-setting the document) when its identity changes would reload the App.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appKey, previewDraftId, context.app.versionId])

  return (
    <iframe
      ref={iframeRef}
      title={context.app.name}
      // Opaque origin: allow-scripts ONLY. No allow-same-origin (that would
      // re-grant the parent origin and defeat the whole isolation model).
      sandbox="allow-scripts"
      key={`${appKey}:${previewDraftId ?? context.app.versionId ?? 'active'}`}
      style={{ width: '100%', height: '100%', minHeight: 'calc(100vh - 8rem)', border: '0', display: 'block' }}
    />
  )
}

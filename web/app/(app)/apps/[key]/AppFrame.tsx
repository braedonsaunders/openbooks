'use client'

import { useEffect, useRef } from 'react'
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
  // Relay bridge calls from THIS iframe to the server, post results back.
  useEffect(() => {
    async function onMessage(e: MessageEvent) {
      const iframe = iframeRef.current
      if (!iframe || e.source !== iframe.contentWindow) return // only our sandbox
      const req = parseBridgeRequest(e.data)
      if (!req) return
      const post = (ok: boolean, payload: unknown) =>
        iframe.contentWindow?.postMessage(makeBridgeResult(req.id, ok, payload), '*')

      if (previewDraftId) { post(false, 'Draft preview does not execute backend actions or access live data'); return }
      if (!isBridgeMethod(req.method)) {
        post(false, `unknown bridge method: ${req.method}`)
        return
      }
      try {
        const res = await fetch(`/api/apps/${encodeURIComponent(appKey)}/bridge`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ method: req.method, payload: req.payload, versionId: context.app.versionId }),
        })
        // The status is checked before the body is parsed: a non-JSON error
        // body must surface the failure, never a SyntaxError from res.json()
        // and never an empty object that hides the server's refusal.
        if (!res.ok) {
          post(false, await readApiErrorMessage(res, 'bridge call failed'))
          return
        }
        const json = await res.json()
        if (json?.ok === false) {
          post(
            false,
            typeof json?.error === 'string' && json.error.trim() !== ''
              ? json.error
              : `bridge call failed (status ${res.status})`,
          )
        } else post(true, json.result)
      } catch (err) {
        post(false, (err as Error).message)
      }
    }
    window.addEventListener('message', onMessage)
    // Start the document only after the bridge listener exists. Warm responses
    // may otherwise execute before React hydrates and lose the first request.
    if (iframeRef.current) iframeRef.current.src = `/api/apps/${encodeURIComponent(appKey)}/sandbox${previewDraftId ? `?draft=${encodeURIComponent(previewDraftId)}` : context.app.versionId ? `?versionId=${encodeURIComponent(context.app.versionId)}` : ''}`
    return () => window.removeEventListener('message', onMessage)
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

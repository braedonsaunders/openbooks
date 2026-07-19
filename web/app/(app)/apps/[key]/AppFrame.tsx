'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  APP_CSP,
  bridgeClientSource,
  inlineDocument,
  makeBridgeResult,
  parseBridgeRequest,
  isBridgeMethod,
  type BridgeContext,
} from '@/lib/apps/bridge'

/**
 * AppFrame — the host side of an installed App's frontend. Fetches the bundle,
 * assembles a single self-contained HTML document (assets inlined as data:
 * URLs, CSP + bridge SDK injected), and renders it in an OPAQUE-ORIGIN
 * sandboxed iframe (sandbox="allow-scripts", deliberately no allow-same-origin).
 * The App therefore runs with no cookies, no parent-DOM access, and no network
 * of its own — its only capability is bridge calls, which this component relays
 * to the permission-checked /api/apps/<key>/bridge route on the user's behalf.
 */

interface BundleResponse {
  entry: string
  entryHtml: string
  /** path → data: URL for every non-entry asset (css/js/img/font). */
  replacements: Record<string, string>
}

export function AppFrame({
  appKey,
  context,
}: {
  appKey: string
  context: BridgeContext
}) {
  const t = useTranslations('apps.frame')
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [bundle, setBundle] = useState<BundleResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Fetch + assemble the sandboxed document.
  useEffect(() => {
    let cancelled = false
    setBundle(null)
    setError(null)
    fetch(`/api/apps/${encodeURIComponent(appKey)}/bundle`, { credentials: 'same-origin' })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `bundle load failed (${r.status})`)
        return (await r.json()) as BundleResponse
      })
      .then((b) => !cancelled && setBundle(b))
      .catch((e) => !cancelled && setError((e as Error).message))
    return () => {
      cancelled = true
    }
  }, [appKey])

  const srcDoc = useMemo(() => {
    if (!bundle) return null
    const head =
      `<meta http-equiv="Content-Security-Policy" content="${APP_CSP}">` +
      `<script>${bridgeClientSource(context)}</script>`
    return inlineDocument(bundle.entryHtml, bundle.replacements, head)
  }, [bundle, context])

  // Relay bridge calls from THIS iframe to the server, post results back.
  useEffect(() => {
    async function onMessage(e: MessageEvent) {
      const iframe = iframeRef.current
      if (!iframe || e.source !== iframe.contentWindow) return // only our sandbox
      const req = parseBridgeRequest(e.data)
      if (!req) return
      const post = (ok: boolean, payload: unknown) =>
        iframe.contentWindow?.postMessage(makeBridgeResult(req.id, ok, payload), '*')

      if (!isBridgeMethod(req.method)) {
        post(false, `unknown bridge method: ${req.method}`)
        return
      }
      try {
        const res = await fetch(`/api/apps/${encodeURIComponent(appKey)}/bridge`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ method: req.method, payload: req.payload }),
        })
        const json = await res.json().catch(() => ({}))
        if (!res.ok || json?.ok === false) post(false, json?.error || `bridge call failed (${res.status})`)
        else post(true, json.result)
      } catch (err) {
        post(false, (err as Error).message)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [appKey])

  if (error) {
    return (
      <div style={{ padding: 24 }}>
        <strong>{t('failedTitle')}</strong>
        <div style={{ marginTop: 8, opacity: 0.7, fontSize: 13 }}>{t('failedHint')}</div>
        <div style={{ marginTop: 8, fontFamily: 'monospace', fontSize: 12, opacity: 0.45 }}>{error}</div>
      </div>
    )
  }
  if (!srcDoc) {
    return <div style={{ padding: 24, opacity: 0.6 }}>{t('loading')}</div>
  }
  return (
    <iframe
      ref={iframeRef}
      title={`app-${appKey}`}
      // Opaque origin: allow-scripts ONLY. No allow-same-origin (that would
      // re-grant the parent origin and defeat the whole isolation model).
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      style={{ width: '100%', height: '100%', minHeight: 'calc(100vh - 8rem)', border: '0', display: 'block' }}
    />
  )
}

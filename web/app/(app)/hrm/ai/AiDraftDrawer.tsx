'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button, UrlDrawer } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../../lib/api-error'

/** Record routes for the cited sources; unknown kinds render as text. */
function sourceHref(kind: string, id: string): string | null {
  switch (kind) {
    case 'hrm_requisition':
      return `/hrm/recruiting?requisition=${id}`
    case 'hrm_review':
      return `/hrm/performance?review=${id}`
    case 'hrm_goal':
      return `/hrm/performance?goal=${id}`
    case 'hrm_process':
      return `/hrm/processes?process=${id}`
    case 'hrm_offer':
      return `/hrm/recruiting?offer=${id}`
    case 'position_version':
      return `/hrm/positions?position=${id}`
    default:
      return null
  }
}

/**
 * Evidence-grounded draft drawer (HR-21). Opened from ?draft=<kind>:<id>,
 * it POSTs the kind and subject to /api/ai/drafts and shows the draft,
 * the sources list, and the bias flags. Insert fills the existing form
 * field (by element id) and records acceptance; Discard records
 * rejection. The draft is never filed anywhere by this drawer — the
 * human submits through the existing form.
 */
/** What the drafting service returns: the text plus what it was built from. */
type Draft = {
  text: string
  sources: { kind: string; id: string; excerpt: string }[]
  biasFlags: { term: string; excerpt: string }[]
  decisionId: string
}

export function AiDraftDrawer({
  draftParam,
  closeHref,
  fieldId,
  title,
  insertLabel,
  discardLabel,
  failedLabel,
  sourcesTitle,
  biasTitle,
  loadingLabel,
  copiedLabel,
}: {
  draftParam: string | null
  closeHref: string
  fieldId: string
  title: string
  insertLabel: string
  discardLabel: string
  failedLabel: string
  sourcesTitle: string
  biasTitle: string
  loadingLabel: string
  copiedLabel: string
}) {
  const router = useRouter()
  // Both the draft and any failure are stored WITH the request they
  // belong to. The drawer is keyed by a url param, so without that the
  // previous subject's draft (or its error) shows for a frame when you
  // open a different one -- and on this surface that frame is one
  // person's evidence-grounded text appearing under another's name.
  const [loaded, setLoaded] = useState<{ param: string; draft: Draft } | null>(null)
  const [failed, setFailed] = useState<{ param: string; message: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const draft = loaded && loaded.param === draftParam ? loaded.draft : null
  const status = failed && failed.param === draftParam ? failed.message : null
  // Busy is a fact about the other two, not a third copy of the same
  // state: a draft is being fetched while one is asked for, none has
  // arrived, and nothing has failed.
  const busy = Boolean(draftParam) && draft === null && status === null
  useEffect(() => {
    if (!draftParam) return
    const separator = draftParam.indexOf(':')
    const kind = separator < 0 ? '' : draftParam.slice(0, separator)
    const subjectId = separator < 0 ? '' : draftParam.slice(separator + 1)
    if (!kind || !subjectId) return
    const requested = draftParam
    let cancelled = false
    fetch('/api/ai/drafts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, subjectId }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const message = await readApiErrorMessage(res, failedLabel)
          if (!cancelled) setFailed({ param: requested, message })
          return
        }
        const body = (await res.json()) as { draft: Draft }
        if (!cancelled) setLoaded({ param: requested, draft: body.draft })
      })
      .catch(() => {
        if (!cancelled) setFailed({ param: requested, message: failedLabel })
      })
    return () => {
      cancelled = true
    }
  }, [draftParam, failedLabel])
  if (!draftParam) return null
  const close = async (outcome: 'accepted' | 'rejected' | null, decisionId: string | null): Promise<void> => {
    if (outcome && decisionId) {
      try {
        const res = await fetch('/api/ai/drafts', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ decisionId, outcome }),
        })
        if (!res.ok) {
          setFailed({ param: draftParam, message: await readApiErrorMessage(res, failedLabel) })
          return
        }
      } catch {
        setFailed({ param: draftParam, message: failedLabel })
        return
      }
    }
    router.push(closeHref)
  }
  const insert = async (): Promise<void> => {
    if (!draft) return
    const field = fieldId ? document.getElementById(fieldId) : null
    if (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) {
      const setter = Object.getOwnPropertyDescriptor(
        field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
        'value',
      )?.set
      setter?.call(field, draft.text)
      field.dispatchEvent(new Event('input', { bubbles: true }))
      await close('accepted', draft.decisionId)
      return
    }
    // No editable field on this host (detail drawers): copy to the
    // clipboard and say so, still recording acceptance of the draft.
    if (navigator.clipboard) {
      void navigator.clipboard.writeText(draft.text).then(
        () => setCopied(true),
        () => setFailed({ param: draftParam, message: failedLabel }),
      )
    }
    await close('accepted', draft.decisionId)
  }
  return (
    <UrlDrawer open closeHref={closeHref} title={title}>
      <div className="space-y-3">
        {busy ? <p className="text-sm text-slate-500 dark:text-slate-400">{loadingLabel}</p> : null}
        {status ? <p role="alert" className="text-sm text-red-600 dark:text-red-400">{status}</p> : null}
        {draft ? (
          <>
            <p className="whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-200">{draft.text}</p>
            <section>
              <h3 className="mb-1 text-sm font-medium">{sourcesTitle}</h3>
              <ul className="text-xs text-slate-500 dark:text-slate-400">
                {draft.sources.map((source) => {
                  const href = sourceHref(source.kind, source.id)
                  return (
                    <li key={`${source.kind}:${source.id}`}>
                      {href ? (
                        <a href={href} className="text-teal-700 dark:text-teal-300">
                          {source.kind} · {source.id}
                        </a>
                      ) : (
                        <span>
                          {source.kind} · {source.id}
                        </span>
                      )}{' '}
                      — {source.excerpt}
                    </li>
                  )
                })}
              </ul>
            </section>
            {draft.biasFlags.length > 0 ? (
              <section>
                <h3 className="mb-1 text-sm font-medium">{biasTitle}</h3>
                <ul className="text-xs text-amber-700 dark:text-amber-300">
                  {draft.biasFlags.map((flag) => (
                    <li key={flag.term}>
                      {flag.term} — {flag.excerpt}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            <div className="flex gap-2">
              <Button size="sm" onClick={insert}>
                {insertLabel}
              </Button>
              <Button size="sm" variant="outline" onClick={() => void close('rejected', draft.decisionId)}>
                {discardLabel}
              </Button>
            </div>
            {copied ? <p className="text-xs text-slate-500 dark:text-slate-400">{copiedLabel}</p> : null}
          </>
        ) : null}
      </div>
    </UrlDrawer>
  )
}

'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button } from '@openbooks/ui'
import { BookCheck, Eye, LoaderCircle, Send } from 'lucide-react'
import type { DocKindConfig } from '../lib/document-kinds'

/**
 * Inline submit/post actions for a document list row. Direct-post kinds
 * (card charges, checks, transfers) expose Post from draft; approval-routed
 * kinds expose Submit for approval from draft and Post once approved.
 */
export function DocumentRowActions({
  id,
  status,
  config,
  openHref,
  canPost,
}: {
  id: string
  status: string
  config: DocKindConfig
  openHref: string
  /**
   * Loader-resolved post capability for the row's namespace (the same
   * decision the drawer reads). Without it the row never offers an enabled
   * Post: the server still refuses, but the operator learns the required
   * grant up front instead of on click.
   */
  canPost: boolean
}) {
  const t = useTranslations(config.i18n)
  const tCommon = useTranslations('common')
  // The grant the disabled Post names — the same key the API refuses with
  // (`missing permission: ${perm}`), so the row and the refusal agree.
  const requiredPostPermission = config.permNamespace === 'gl' ? 'gl.post' : `${config.permNamespace}.post`
  const postBlockedLabel = tCommon('actions.postRequiresPermission', { permission: requiredPostPermission })
  const [busy, setBusy] = useState(false)
  // A refused submit/post that only fires a transient toast reads as
  // "nothing happened" once it dismisses (the F-t06-018 precedent): the
  // typed refusal also persists row-inline, cleared on the next action.
  const [refusal, setRefusal] = useState<string | null>(null)
  const router = useRouter()

  async function act(action: 'submit' | 'post') {
    setBusy(true)
    setRefusal(null)
    try {
      const res = await fetch('/api/documents/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, documentId: id }),
      })
      // The error body may not be JSON (proxy 5xx pages): never let the read
      // itself throw, or the failure goes silent with an unhandled rejection.
      const data = (await res.json().catch(() => ({}))) as { error?: unknown }
      if (!res.ok) {
        const message = typeof data.error === 'string' && data.error ? data.error : t('toasts.actionFailed')
        setRefusal(message)
        toast.error(message)
      } else toast.success(action === 'submit' ? t('toasts.submitted') : t('toasts.posted'))
      router.refresh()
    } catch {
      const message = t('toasts.actionFailed')
      setRefusal(message)
      toast.error(message)
    } finally {
      // A rejected transport must not wedge the button on: without this,
      // every later click silently dies on the stuck disabled button.
      setBusy(false)
    }
  }

  const refusalAlert = refusal ? (
    <p role="alert" className="max-w-44 text-right text-xs break-words text-red-600 dark:text-red-400">
      {refusal}
    </p>
  ) : null

  // A Post the role may not take renders disabled with the required grant
  // named — never an enabled button that only the server refuses, and never
  // hidden so thoroughly the preparer cannot see the two-person handoff.
  function postButton({ primary }: { primary: boolean }) {
    if (canPost) {
      return (
        <Button variant={primary ? undefined : 'outline'} size="icon" className="h-7 w-7" disabled={busy} onClick={() => act('post')} aria-label={tCommon('actions.post')} title={tCommon('actions.post')}>
          {busy ? <LoaderCircle size={14} className="animate-spin" /> : <BookCheck size={14} />}
        </Button>
      )
    }
    return (
      <Button variant="outline" size="icon" className="h-7 w-7" disabled aria-label={postBlockedLabel} title={postBlockedLabel}>
        <BookCheck size={14} />
      </Button>
    )
  }

  if (status === 'draft') {
    // Submit-for-approval is a create-namespaced action, not a post: a
    // preparer without post rights still submits; only direct-post drafts
    // gate on canPost.
    if (!config.directPost) {
      const label = t('actions.submitForApproval')
      return (
        <div className="flex flex-col items-end gap-1">
          <Button variant="outline" size="icon" className="h-7 w-7" disabled={busy} onClick={() => act('submit')} aria-label={label} title={label}>
            {busy ? <LoaderCircle size={14} className="animate-spin" /> : <Send size={14} />}
          </Button>
          {refusalAlert}
        </div>
      )
    }
    return (
      <div className="flex flex-col items-end gap-1">
        {postButton({ primary: false })}
        {refusalAlert}
      </div>
    )
  }
  if (status === 'approved' && !config.directPost) {
    return (
      <div className="flex flex-col items-end gap-1">
        {postButton({ primary: true })}
        {refusalAlert}
      </div>
    )
  }
  return (
    <Button variant="ghost" size="icon" className="h-7 w-7" asChild>
      <Link href={openHref} aria-label={tCommon('actions.open')} title={tCommon('actions.open')}><Eye size={14} /></Link>
    </Button>
  )
}

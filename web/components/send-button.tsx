'use client'

// "Send" button for transaction flyouts — emails the record to its party with
// the rendered PDF attached (same template the PDF button prints). A popover
// prefills the party's email on file and takes an optional message.

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { RotateCcw, Send } from 'lucide-react'
import { Button, Input, Label, Popover } from '@openbooks/ui'

/**
 * Opaque machine codes the record-PDF send boundary can answer (the uniform
 * 404 stays `{ error: "not_found" }` by design so a probe learns nothing, and
 * the sibling print routes use the same terse bodies). They name no remedy,
 * so the dialog maps them to the localized failure message with a retry —
 * a raw machine code never renders in the dialog.
 */
const OPAQUE_SEND_FAILURES = new Set([
  'not_found',
  'record not found',
  'template not found',
  'unknown record type',
])

export function SendButton({ recordType, recordId, baseUrl }: { recordType: string; recordId: string; baseUrl?: string }) {
  const t = useTranslations('pdfTemplates')
  const tCommon = useTranslations('common')
  const [open, setOpen] = useState(false)
  const [to, setTo] = useState('')
  const [message, setMessage] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  // Persistent failure text inside the composer: the error toast
  // auto-dismisses, and a missed toast reads as a silent send.
  const [error, setError] = useState<string | null>(null)

  // Endpoints that speak the record-pdf send contract (GET { to }, POST
  // { to, message }) can reuse this composer, e.g. party statements.
  const base = baseUrl ?? `/api/record-pdf/${encodeURIComponent(recordType)}/${encodeURIComponent(recordId)}/send`

  async function onOpenChange(next: boolean) {
    setOpen(next)
    if (next && !loaded) {
      setLoaded(true)
      try {
        const res = await fetch(base)
        if (res.ok) {
          const d = (await res.json()) as { to: string | null }
          if (d.to) setTo(d.to)
        }
      } catch {
        /* leave recipient blank; the user can type it */
      }
    }
  }

  async function send() {
    if (!to.trim()) {
      toast.error(t('send.noRecipient'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: to.trim(), message: message.trim() || undefined }),
      })
      // The status is checked before the error body is trusted: a non-JSON
      // error body (proxy page) must surface the localized failure, never a
      // SyntaxError or an empty throw.
      const d = (await res.json().catch(() => ({}))) as { to?: string; error?: string }
      if (!res.ok) throw new Error(typeof d.error === 'string' ? d.error : '')
      toast.success(t('send.sent', { to: d.to ?? to.trim() }))
      setOpen(false)
      setMessage('')
    } catch (e) {
      const raw = e instanceof Error ? e.message.trim() : ''
      // Opaque machine codes (not_found and its terse siblings) name no
      // remedy, so they render as the localized failure with a retry instead
      // of the raw code. Actionable server sentences (no recipient, no email
      // transport, renderer refusal) still read verbatim.
      const failure = raw && !OPAQUE_SEND_FAILURES.has(raw) ? raw : t('send.failed')
      setError(failure)
      toast.error(failure)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      trigger={
        <Button variant="outline" onClick={() => onOpenChange(true)}>
          <Send size={15} className="mr-1.5" />
          {t('send.label')}
        </Button>
      }
    >
      <div className="w-72 space-y-3 p-3">
        <div className="space-y-1.5">
          <Label htmlFor="send-to">{t('send.to')}</Label>
          <Input
            id="send-to"
            type="email"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder={t('send.toPlaceholder')}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="send-message">{t('send.message')}</Label>
          <textarea
            id="send-message"
            rows={3}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={t('send.messagePlaceholder')}
            className="w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-sm focus:border-teal-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900"
          />
        </div>
        {error ? (
          <div className="space-y-1.5">
            <p role="alert" className="text-xs text-red-600 dark:text-red-400">
              {error}
            </p>
            <Button variant="outline" size="sm" className="w-full" onClick={send} disabled={busy}>
              <RotateCcw size={14} className="mr-1.5" />
              {tCommon('actions.retry')}
            </Button>
          </div>
        ) : null}
        <Button className="w-full" onClick={send} disabled={busy}>
          <Send size={14} className="mr-1.5" />
          {busy ? t('send.sending') : t('send.action')}
        </Button>
      </div>
    </Popover>
  )
}

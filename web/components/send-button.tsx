'use client'

// "Send" button for transaction flyouts — emails the record to its party with
// the rendered PDF attached (same template the PDF button prints). A popover
// prefills the party's email on file and takes an optional message.

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Send } from 'lucide-react'
import { Button, Input, Label, Popover } from '@openbooks/ui'

export function SendButton({ recordType, recordId }: { recordType: string; recordId: string }) {
  const t = useTranslations('pdfTemplates')
  const [open, setOpen] = useState(false)
  const [to, setTo] = useState('')
  const [message, setMessage] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)

  const base = `/api/record-pdf/${encodeURIComponent(recordType)}/${encodeURIComponent(recordId)}/send`

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
    try {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: to.trim(), message: message.trim() || undefined }),
      })
      const d = (await res.json().catch(() => ({}))) as { to?: string; error?: string }
      if (!res.ok) throw new Error(d.error)
      toast.success(t('send.sent', { to: d.to ?? to.trim() }))
      setOpen(false)
      setMessage('')
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : t('send.failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      trigger={
        <Button variant="outline">
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
        <Button className="w-full" onClick={send} disabled={busy}>
          <Send size={14} className="mr-1.5" />
          {busy ? t('send.sending') : t('send.action')}
        </Button>
      </div>
    </Popover>
  )
}

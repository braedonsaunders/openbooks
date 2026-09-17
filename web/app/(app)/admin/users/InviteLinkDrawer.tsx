'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Check, Copy } from 'lucide-react'
import { Button, Drawer, Input, Label } from '@openbooks/ui'

/**
 * One-time set-password link display. Shown when email delivery is not
 * configured and the invite/resend response carried the raw link: the token
 * exists only here and in the stored SHA-256, so the admin must copy it now
 * — closing loses it. Never rendered when the email path worked.
 */
export function InviteLinkDrawer({
  email,
  url,
  onClose,
}: {
  email: string
  url: string
  onClose: () => void
}) {
  const t = useTranslations('admin.users')
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url)
      } else {
        const field = document.getElementById('invite-link-value') as HTMLInputElement | null
        field?.select()
        field?.setSelectionRange(0, field.value.length)
        if (!document.execCommand('copy')) throw new Error('copy unavailable')
      }
      setCopied(true)
      toast.success(t('inviteCopied'))
    } catch {
      toast.error(t('inviteCopyFailed'))
    }
  }

  return (
    <Drawer
      open
      onClose={onClose}
      size="md"
      title={t('inviteLinkTitle')}
      description={t('inviteLinkOneTime')}
      headerActions={
        <Button disabled={copied} onClick={copy}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? t('inviteCopied') : t('inviteCopyLink')}
        </Button>
      }
    >
      <div className="space-y-5">
        <div className="space-y-1.5">
          <Label htmlFor="invite-link-email">{t('inviteEmailLabel')}</Label>
          <Input id="invite-link-email" value={email} disabled readOnly />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="invite-link-value">{t('inviteLinkTitle')}</Label>
          <Input
            id="invite-link-value"
            value={url}
            readOnly
            onFocus={(e) => e.target.select()}
          />
        </div>
      </div>
    </Drawer>
  )
}

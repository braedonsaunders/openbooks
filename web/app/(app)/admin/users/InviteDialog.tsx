'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button, Drawer, Input, Label, Select } from '@openbooks/ui'
import { InviteLinkDrawer } from './InviteLinkDrawer'

/**
 * Invite-user entry point for the Users page header. Mirrors the roles
 * page's NewRoleButton: a primary button opening a Drawer with the new
 * user's email and first role; submit POSTs action=invite and the page
 * refreshes to show the pending row.
 */
export function InviteUserButton({
  allRoles,
}: {
  allRoles: { id: string; name: string; isBuiltIn: boolean }[]
}) {
  const t = useTranslations('admin.users')
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)}>{t('inviteButton')}</Button>
      {open ? (
        <InviteDrawer allRoles={allRoles} onClose={() => setOpen(false)} />
      ) : null}
    </>
  )
}

function InviteDrawer({
  allRoles,
  onClose,
}: {
  allRoles: { id: string; name: string; isBuiltIn: boolean }[]
  onClose: () => void
}) {
  const t = useTranslations('admin.users')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [roleId, setRoleId] = useState(allRoles[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const [link, setLink] = useState<string | null>(null)

  // The one-time link replaces the form: it is shown once and never stored,
  // so navigating away before copying loses it.
  if (link) {
    return (
      <InviteLinkDrawer
        email={email.trim()}
        url={link}
        onClose={() => {
          setLink(null)
          onClose()
          router.refresh()
        }}
      />
    )
  }

  async function send() {
    if (!email.trim()) {
      toast.error(t('inviteEmailRequired'))
      return
    }
    if (!roleId) {
      toast.error(t('noRoles'))
      return
    }
    setBusy(true)
    const res = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'invite', email: email.trim(), roleId }),
    })
    setBusy(false)
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      toast.error(res.status === 429 ? t('inviteTooManyAttempts') : (data.error ?? t('requestFailed')))
      return
    }
    const payload = await res.json().catch(() => ({}))
    if (typeof payload.setPasswordUrl === 'string') {
      setLink(payload.setPasswordUrl)
      return
    }
    toast.success(t('inviteSent', { email: email.trim() }))
    onClose()
    router.refresh()
  }

  return (
    <Drawer
      open
      onClose={onClose}
      size="md"
      title={t('inviteTitle')}
      description={t('inviteDescription')}
      headerActions={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {tCommon('actions.cancel')}
          </Button>
          <Button disabled={busy} onClick={send}>
            {t('inviteSend')}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="space-y-1.5">
          <Label htmlFor="invite-email">{t('inviteEmailLabel')}</Label>
          <Input
            id="invite-email"
            type="email"
            autoComplete="email"
            value={email}
            disabled={busy}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t('inviteEmailPlaceholder')}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="invite-role">{t('table.roles')}</Label>
          {allRoles.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">{t('noRoles')}</p>
          ) : (
            <Select
              id="invite-role"
              value={roleId}
              disabled={busy}
              onChange={(e) => setRoleId(e.target.value)}
            >
              {allRoles.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.name}
                </option>
              ))}
            </Select>
          )}
        </div>
      </div>
    </Drawer>
  )
}

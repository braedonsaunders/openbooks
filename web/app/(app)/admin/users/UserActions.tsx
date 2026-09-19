'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Check, UserCog } from 'lucide-react'
import { Badge, Button, cn, Drawer, Label, Popover, SearchSelect, Textarea } from '@openbooks/ui'
import { confirmDialog } from '@/lib/confirm'
import { InviteLinkDrawer } from './InviteLinkDrawer'

async function post(body: Record<string, unknown>, failedMessage: string): Promise<boolean> {
  const res = await fetch('/api/admin/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    toast.error(data.error ?? failedMessage)
    return false
  }
  return true
}

/**
 * Per-user role editor: a popover listing every role in the org with a
 * check toggle. Clicking a role assigns/unassigns it immediately.
 */
export function RoleAssignmentButton({
  userId,
  userName,
  allRoles,
  assignedRoleIds,
}: {
  userId: string
  userName: string
  allRoles: { id: string; name: string; isBuiltIn: boolean }[]
  assignedRoleIds: string[]
}) {
  const t = useTranslations('admin.users')
  const [open, setOpen] = useState(false)
  const [busyRole, setBusyRole] = useState<string | null>(null)
  const router = useRouter()
  const assigned = new Set(assignedRoleIds)

  async function toggle(roleId: string) {
    setBusyRole(roleId)
    const ok = await post(
      {
        action: assigned.has(roleId) ? 'unassign' : 'assign',
        userId,
        roleId,
      },
      t('requestFailed'),
    )
    setBusyRole(null)
    if (ok) router.refresh()
  }

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="start"
      className="min-w-[16rem] p-1"
      trigger={
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={t('editRolesFor', { name: userName })}
          onClick={() => setOpen((v) => !v)}
          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-200"
        >
          <UserCog size={14} />
        </button>
      }
    >
      <div className="px-2 pt-1.5 pb-1 text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
        {t('rolesFor', { name: userName })}
      </div>
      <div className="max-h-72 overflow-auto">
        {allRoles.length === 0 ? (
          <p className="px-2 py-2 text-sm text-slate-500 dark:text-slate-400">
            {t('noRoles')}
          </p>
        ) : (
          allRoles.map((role) => {
            const active = assigned.has(role.id)
            return (
              <button
                key={role.id}
                type="button"
                disabled={busyRole !== null}
                onClick={() => toggle(role.id)}
                className={cn(
                  'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors disabled:opacity-50',
                  active
                    ? 'bg-teal-50 font-medium text-teal-800 dark:bg-teal-950/50 dark:text-teal-300'
                    : 'text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800/60',
                )}
              >
                <Check
                  size={14}
                  className={cn('shrink-0', active ? 'text-teal-600' : 'text-transparent')}
                />
                <span className="flex-1 truncate">{role.name}</span>
                {role.isBuiltIn ? (
                  <Badge variant="secondary" className="text-[10px]">
                    {t('builtInBadge')}
                  </Badge>
                ) : null}
              </button>
            )
          })
        )}
      </div>
    </Popover>
  )
}

/**
 * Re-issue the set-password link for a still-pending invite. Renders only on
 * pending rows: when email delivery is unconfigured the response carries the
 * one-time link and it opens in the copy drawer; otherwise a sent toast.
 */
export function ResendInviteButton({
  userId,
  userEmail,
  isPending,
}: {
  userId: string
  userEmail: string
  isPending: boolean
}) {
  const t = useTranslations('admin.users')
  const [busy, setBusy] = useState(false)
  const [link, setLink] = useState<string | null>(null)
  const router = useRouter()

  if (!isPending) return null

  async function resend() {
    setBusy(true)
    const res = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'resend-invite', userId }),
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
    toast.success(t('inviteResent', { email: userEmail }))
    router.refresh()
  }

  return (
    <>
      <Button size="sm" variant="outline" disabled={busy} onClick={resend}>
        {t('inviteResend')}
      </Button>
      {link ? (
        <InviteLinkDrawer
          email={userEmail}
          url={link}
          onClose={() => {
            setLink(null)
            router.refresh()
          }}
        />
      ) : null}
    </>
  )
}

/** Deactivate / reactivate a user (blocked for your own account). */
export function ActiveToggle({
  userId,
  userName,
  isActive,
  isSelf,
}: {
  userId: string
  userName: string
  isActive: boolean
  isSelf: boolean
}) {
  const t = useTranslations('admin.users')
  const [busy, setBusy] = useState(false)
  const router = useRouter()

  async function toggle() {
    if (isActive) {
      const ok = await confirmDialog({
        message: t('deactivateConfirm', { name: userName }),
        tone: 'danger',
        confirmLabel: t('deactivate'),
      })
      if (!ok) return
    }
    setBusy(true)
    const ok = await post({ action: 'set-active', userId, isActive: !isActive }, t('requestFailed'))
    setBusy(false)
    if (ok) {
      toast.success(isActive ? t('deactivated', { name: userName }) : t('reactivated', { name: userName }))
      router.refresh()
    }
  }

  if (isSelf) return null
  return (
    <Button size="sm" variant="outline" disabled={busy} onClick={toggle}>
      {isActive ? t('deactivate') : t('reactivate')}
    </Button>
  )
}

type PersonOption = {
  value: string
  label: string
  hint?: string
  kind: string
  roles: string[]
  isActive: boolean
}

/**
 * Native linked-person editor. Opens a Drawer with a remote SearchSelect
 * over active native parties (per-query bounded page, never a fixed first-N
 * roster), a required reason, and an explicit human-identity attestation.
 * Mirrors InviteDrawer: Drawer shell, res.ok before parsing, toast plus
 * inline error, router.refresh() on success.
 *
 * Separation of duties is explicit in the UI: your own row renders disabled
 * with the refusal explanation — the server refuses it even for superadmin
 * and another administrator must perform it.
 */
export function LinkPersonButton({
  userId,
  userName,
  partyId,
  partyName,
  isSelf,
}: {
  userId: string
  userName: string
  partyId: string | null
  partyName: string | null
  isSelf: boolean
}) {
  const t = useTranslations('admin.users')
  const [open, setOpen] = useState(false)
  const router = useRouter()
  if (isSelf) {
    return (
      <Button
        size="sm"
        variant="outline"
        disabled
        title={t('linkSelfRefused')}
        aria-label={t('linkSelfRefused')}
      >
        {partyId ? t('linkChangePerson') : t('linkPersonButton')}
      </Button>
    )
  }
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        {partyId ? t('linkChangePerson') : t('linkPersonButton')}
      </Button>
      {open ? (
        <LinkPersonDrawer
          userId={userId}
          userName={userName}
          expectedPartyId={partyId}
          initialOption={partyId && partyName ? { value: partyId, label: partyName } : null}
          onClose={() => {
            setOpen(false)
            router.refresh()
          }}
        />
      ) : null}
    </>
  )
}

function LinkPersonDrawer({
  userId,
  userName,
  expectedPartyId,
  initialOption,
  onClose,
}: {
  userId: string
  userName: string
  expectedPartyId: string | null
  initialOption: { value: string; label: string } | null
  onClose: () => void
}) {
  const t = useTranslations('admin.users')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const [value, setValue] = useState(initialOption?.value ?? '')
  const [selectedOption, setSelectedOption] = useState<{ value: string; label: string } | null>(initialOption)
  const [options, setOptions] = useState<PersonOption[]>([])
  const [query, setQuery] = useState('')
  // True from mount: the first page is fetched as soon as the drawer opens.
  const [loading, setLoading] = useState(true)
  const [statusMessage, setStatusMessage] = useState<string | undefined>(undefined)
  const [reason, setReason] = useState('')
  const [attested, setAttested] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const requestId = useRef(0)

  // Remote per-query search: bounded page per query so people beyond the
  // first page stay selectable. A sequence guard drops stale responses so a
  // slow earlier query never overwrites newer results. The selected option
  // is merged back when the page does not contain it.
  useEffect(() => {
    const id = (requestId.current += 1)
    const params = new URLSearchParams()
    if (query.trim()) params.set('q', query.trim())
    params.set('limit', '25')
    const include = value || expectedPartyId
    if (include) params.set('include', include)
    fetch(`/api/admin/users?${params.toString()}`, { method: 'GET' })
      .then(async (res) => {
        if (id !== requestId.current) return
        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          setStatusMessage((data as { error?: string }).error ?? t('requestFailed'))
          setLoading(false)
          return
        }
        const payload = (await res.json().catch(() => ({}))) as {
          options?: PersonOption[]
          selected?: PersonOption | null
        }
        if (id !== requestId.current) return
        const page = Array.isArray(payload.options) ? payload.options : []
        const merged = [...page]
        const ensure = (opt: { value: string; label: string; hint?: string } | null | undefined) => {
          if (!opt || !opt.value) return
          if (!merged.some((o) => o.value === opt.value)) {
            merged.push({
              value: opt.value,
              label: opt.label,
              hint: opt.hint,
              kind: '',
              roles: [],
              isActive: true,
            })
          }
        }
        ensure(payload.selected)
        ensure(selectedOption)
        setOptions(merged)
        setLoading(false)
      })
      .catch(() => {
        if (id !== requestId.current) return
        setStatusMessage(t('requestFailed'))
        setLoading(false)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  function pick(next: string) {
    setValue(next)
    setError(null)
    if (!next) {
      setSelectedOption(null)
      return
    }
    const found = options.find((o) => o.value === next)
    setSelectedOption(found ? { value: found.value, label: found.label } : { value: next, label: next })
  }

  async function save() {
    if (!reason.trim()) {
      setError(t('linkReasonRequired'))
      return
    }
    if (!attested) {
      setError(t('linkAttestationRequired'))
      return
    }
    setBusy(true)
    setError(null)
    const res = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'set-party',
        userId,
        partyId: value || null,
        expectedPartyId,
        reason: reason.trim(),
        attestation: true,
      }),
    })
    setBusy(false)
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      const message = (data as { error?: string }).error ?? t('requestFailed')
      setError(message)
      toast.error(message)
      return
    }
    await res.json().catch(() => ({}))
    toast.success(t('linkSaved'))
    onClose()
    router.refresh()
  }

  return (
    <Drawer
      open
      onClose={onClose}
      size="md"
      title={t('linkPersonTitle', { name: userName })}
      description={t('linkPersonDescription')}
      headerActions={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {tCommon('actions.cancel')}
          </Button>
          <Button disabled={busy} onClick={save}>
            {t('linkSave')}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="space-y-1.5">
          <Label htmlFor="link-person-search">{t('linkPersonLabel')}</Label>
          <SearchSelect
            id="link-person-search"
            value={value}
            onChange={pick}
            options={options.map((o) => ({ value: o.value, label: o.label, hint: o.hint }))}
            placeholder={t('linkPersonPlaceholder')}
            searchPlaceholder={t('linkPersonSearchPlaceholder')}
            sheetTitle={t('linkPersonLabel')}
            ariaLabel={t('linkPersonLabel')}
            clearable
            emptyLabel={t('unlinkedPerson')}
            remote
            loading={loading}
            statusMessage={statusMessage}
            statusTone={statusMessage ? 'error' : 'muted'}
            onSearchChange={(next) => {
              setQuery(next)
              setLoading(true)
              setStatusMessage(undefined)
            }}
          />
          <p className="text-xs text-slate-500 dark:text-slate-400">{t('linkPersonSignalsNote')}</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="link-person-reason">{t('linkReasonLabel')}</Label>
          <Textarea
            id="link-person-reason"
            value={reason}
            disabled={busy}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('linkReasonPlaceholder')}
            required
          />
        </div>
        <div className="flex items-start gap-2">
          <input
            id="link-person-attest"
            type="checkbox"
            checked={attested}
            disabled={busy}
            onChange={(e) => setAttested(e.target.checked)}
            className="mt-1 h-4 w-4 rounded border-slate-300"
            required
          />
          <Label htmlFor="link-person-attest">{t('linkAttestationLabel')}</Label>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        ) : null}
      </div>
    </Drawer>
  )
}

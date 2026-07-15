'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Check, UserCog } from 'lucide-react'
import { Badge, Button, cn, Popover } from '@openbooks/ui'
import { confirmDialog } from '@/lib/confirm'

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

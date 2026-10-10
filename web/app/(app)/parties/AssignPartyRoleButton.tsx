'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button, Select } from '@openbooks/ui'
import { confirmDialog } from '@/lib/confirm'
import { readApiErrorMessage } from '@/lib/api-error'

/**
 * Bulk role assignment for the role-less directory slice. Renders beside the
 * directory filters while the list shows parties with no role: the operator
 * picks the native role once and every listed party gains it through the
 * bulk endpoint, which re-applies this same slice server-side under the
 * caller's subsidiary fence. The directory refreshes so the promoted rows
 * leave the slice.
 */
export function AssignPartyRoleButton({
  roles,
  total,
  q,
  includeInactive,
}: {
  roles: { value: string; label: string }[]
  total: number
  q: string
  includeInactive: boolean
}) {
  const t = useTranslations('parties')
  const router = useRouter()
  const [role, setRole] = useState(roles[0]?.value ?? 'customer')
  const [busy, setBusy] = useState(false)

  async function assign() {
    const roleLabel = roles.find((r) => r.value === role)?.label ?? role
    const confirmed = await confirmDialog({
      title: t('list.assignRoleTitle'),
      message: t('list.assignRoleConfirm', { count: total, role: roleLabel }),
      confirmLabel: t('list.assignRole'),
    })
    if (!confirmed) return
    setBusy(true)
    try {
      const res = await fetch('/api/parties/roles/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role, q: q || undefined, includeInactive: includeInactive || undefined }),
      })
      if (!res.ok) throw new Error(await readApiErrorMessage(res, t('list.assignRoleFailed')))
      const data = (await res.json().catch(() => null)) as { assigned?: unknown; total?: unknown } | null
      if (typeof data?.assigned !== 'number') throw new Error(t('list.assignRoleFailed'))
      toast.success(t('list.assignRoleDone', { count: data.assigned, role: roleLabel }))
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('list.assignRoleFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        aria-label={t('list.assignRole')}
        value={role}
        disabled={busy}
        onChange={(event) => setRole(event.target.value)}
        triggerClassName="h-8 w-auto"
      >
        {roles.map((r) => (
          <option key={r.value} value={r.value}>{r.label}</option>
        ))}
      </Select>
      <Button size="sm" variant="outline" disabled={busy || total === 0} onClick={assign}>
        {t('list.assignRole')}
      </Button>
    </div>
  )
}

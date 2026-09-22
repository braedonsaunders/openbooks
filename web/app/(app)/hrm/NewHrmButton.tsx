'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { NewMenuButton, type NewMenuItem } from '../../../components/new-menu-button'
import { readApiErrorMessage } from '../../../lib/api-error'

export function NewHrmButton({
  canCreateEmployee,
  canProposeChange,
  canCreateProcess,
  employeeLabel,
  changeLabel,
  processLabel,
}: {
  canCreateEmployee: boolean
  canProposeChange: boolean
  canCreateProcess: boolean
  employeeLabel: string
  changeLabel: string
  processLabel: string
}) {
  const tc = useTranslations('common')
  const tp = useTranslations('parties.newParty')
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const items: NewMenuItem[] = [
    ...(canCreateEmployee ? [{ key: 'employee', label: employeeLabel }] : []),
    ...(canProposeChange ? [{ key: 'change', label: changeLabel }] : []),
    ...(canCreateProcess ? [{ key: 'process', label: processLabel }] : []),
  ]

  async function select(key: string) {
    if (key === 'change') {
      router.push('/hrm/change-requests?propose=1' as never)
      return
    }
    if (key === 'process') {
      router.push('/hrm/processes?new=1' as never)
      return
    }
    if (key !== 'employee') return
    setBusy(true)
    const response = await fetch('/api/parties/draft', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'employee' }),
    })
    if (!response.ok) {
      toast.error(await readApiErrorMessage(response, tp('createFailed')))
      setBusy(false)
      return
    }
    const payload = (await response.json()) as { id?: string }
    if (!payload.id) {
      toast.error(tp('createFailed'))
      setBusy(false)
      return
    }
    router.push(`/entities/employees?party=${payload.id}&mode=edit` as never)
    router.refresh()
    setBusy(false)
  }

  return <NewMenuButton label={tc('actions.newRecord')} busyLabel={tc('actions.creating')} items={items} busy={busy} onSelect={select} />
}

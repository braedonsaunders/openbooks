'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { NewMenuButton, type NewMenuItem } from '../../../components/new-menu-button'

export function NewHrmButton({
  canCreateEmployee,
  canProposeChange,
  canCreateProcess,
  employeeLabel,
  changeLabel,
  processLabel,
  hireLabel,
}: {
  canCreateEmployee: boolean
  canProposeChange: boolean
  canCreateProcess: boolean
  employeeLabel: string
  changeLabel: string
  processLabel: string
  hireLabel?: string
}) {
  const tc = useTranslations('common')
  const router = useRouter()
  const items: NewMenuItem[] = [
    ...(canCreateEmployee ? [{ key: 'employee', label: employeeLabel }] : []),
    ...(canProposeChange && hireLabel ? [{ key: 'hire', label: hireLabel }] : []),
    ...(canProposeChange ? [{ key: 'change', label: changeLabel }] : []),
    ...(canCreateProcess ? [{ key: 'process', label: processLabel }] : []),
  ]

  function select(key: string) {
    // A first employment has no employment to pick yet, so Hire opens the
    // queue's propose dialog in hire mode — person picker, no employment
    // picker — rather than the change drawer.
    if (key === 'hire') {
      router.push('/hrm/change-requests?propose=1&hire=1' as never)
      return
    }
    if (key === 'change') {
      router.push('/hrm/change-requests?propose=1' as never)
      return
    }
    if (key === 'process') {
      router.push('/hrm/processes?new=1' as never)
      return
    }
    if (key !== 'employee') return
    // Unsaved-create: zero writes here — the drawer persists the employee
    // with one idempotent POST on explicit Save.
    router.push(`/entities/employees?partyNew=1` as never)
  }

  return <NewMenuButton label={tc('actions.newRecord')} busyLabel={tc('actions.creating')} items={items} onSelect={select} />
}

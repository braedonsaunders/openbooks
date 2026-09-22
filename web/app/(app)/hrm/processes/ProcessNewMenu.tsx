'use client'

import { useRouter } from 'next/navigation'
import { NewMenuButton } from '../../../../components/new-menu-button'

export function ProcessNewMenu({
  newLabel,
  busyLabel,
  checklistLabel,
  templateLabel,
}: {
  newLabel: string
  busyLabel: string
  checklistLabel: string
  templateLabel: string
}) {
  const router = useRouter()
  return (
    <NewMenuButton
      label={newLabel}
      busyLabel={busyLabel}
      items={[
        { key: 'checklist', label: checklistLabel },
        { key: 'template', label: templateLabel },
      ]}
      onSelect={(key) => {
        router.push((key === 'template' ? '/hrm/processes/templates?template=new' : '/hrm/processes?new=1') as never)
      }}
    />
  )
}

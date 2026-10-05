'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { NewMenuButton } from '../../../../components/new-menu-button'

export function NewCompensationButton({ items }: {
  items: { key: string; label: string; href: string }[]
}) {
  const router = useRouter()
  const t = useTranslations('common')
  return (
    <NewMenuButton
      label={t('actions.newRecord')}
      busyLabel={t('actions.creating')}
      items={items}
      onSelect={(key) => {
        const item = items.find((candidate) => candidate.key === key)
        if (item) router.push(item.href as never)
      }}
    />
  )
}

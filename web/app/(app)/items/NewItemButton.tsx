'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Plus } from 'lucide-react'
import { Button } from '@openbooks/ui'

/** Open the true, in-memory create drawer. No item exists until Save. */
export function NewItemButton({ label }: { label?: string } = {}) {
  const t = useTranslations('items')

  return (
    <Button asChild>
      <Link href="/items?item=new">
        <Plus size={15} /> {label ?? t('list.newButton')}
      </Link>
    </Button>
  )
}

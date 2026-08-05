'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Plus } from 'lucide-react'
import { Button } from '@openbooks/ui'

/** Opens the inventory movement drawer (?movement=new). */
export function NewMovementButton() {
  const t = useTranslations('inventory')
  return (
    <Button asChild>
      <Link href="/inventory?movement=new">
        <Plus size={15} /> {t('list.newButton')}
      </Link>
    </Button>
  )
}

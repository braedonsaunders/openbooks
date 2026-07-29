'use client'

import { useRouter } from 'next/navigation'
import { Plus } from 'lucide-react'
import { Button } from '@openbooks/ui'
import { mergeHref } from '../../../lib/list-params'

export function NewAccountButton({
  currentParams,
  label,
}: {
  currentParams: Record<string, string | string[] | undefined>
  label: string
}) {
  const router = useRouter()
  return (
    <Button
      onClick={() => router.push(mergeHref('/accounts', currentParams, {
        account: undefined,
        accountNew: '1',
      }) as never)}
    >
      <Plus size={16} />
      {label}
    </Button>
  )
}

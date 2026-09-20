'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { Plus } from 'lucide-react'
import { Button } from '@openbooks/ui'

/**
 * The positions page's header primary action: the house Button (default
 * variant and size, so the PageHeader normalises its geometry beside every
 * other page's New button), opening the create form through the URL
 * (`?position=new`) so the drawer is shareable and closes by navigation —
 * the same contract the position detail drawer already honours.
 */
export function AddPositionButton({ basePath, label }: { basePath: string; label: string }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const open = () => {
    const params = new URLSearchParams(searchParams?.toString() ?? '')
    params.set('position', 'new')
    router.push(`${basePath}?${params.toString()}`)
  }
  return (
    <Button onClick={open}>
      <Plus size={16} /> {label}
    </Button>
  )
}

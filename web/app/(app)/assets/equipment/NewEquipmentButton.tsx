'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@openbooks/ui'

export function NewEquipmentButton() {
  const t = useTranslations('assets.equipment')
  const common = useTranslations('common')
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  async function create() {
    setBusy(true)
    const res = await fetch('/api/equipment/draft', { method: 'POST' })
    const data = await res.json()
    if (!res.ok) { toast.error(data.error === 'no_available_subsidiary' ? t('noAvailableSubsidiary') : t('createFailed')); setBusy(false); return }
    router.push(`/assets/equipment?equipment=${data.id}`); router.refresh(); setBusy(false)
  }
  return <Button disabled={busy} onClick={create}><Plus size={15}/>{busy ? common('actions.creating') : t('new')}</Button>
}

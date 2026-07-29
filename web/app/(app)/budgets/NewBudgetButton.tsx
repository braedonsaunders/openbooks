'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Plus } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button } from '@openbooks/ui'
import { mergeHref } from '../../../lib/list-params'

/** Instant-into-draft: persist first, then open the record in its URL drawer. */
export function NewBudgetButton({
  currentParams,
}: {
  currentParams: Record<string, string | string[] | undefined>
}) {
  const t = useTranslations('budgets')
  const tc = useTranslations('common')
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function create() {
    setBusy(true)
    try {
      const response = await fetch('/api/budgets/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: t('list.new') }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error)
      router.push(mergeHref('/budgets', currentParams, {
        budget: data.id,
        budgetNew: '1',
        budgetQ: null,
        budgetPage: null,
        budgetDepartment: null,
        budgetProject: null,
        budgetLocation: null,
        budgetClass: null,
        budgetImport: null,
        budgetView: null,
      }) as any)
      router.refresh()
      setBusy(false)
    } catch {
      toast.error(t('create.failed'))
      setBusy(false)
    }
  }

  return <Button onClick={create} disabled={busy}>
    <Plus size={16} />
    {busy ? tc('actions.creating') : t('list.new')}
  </Button>
}

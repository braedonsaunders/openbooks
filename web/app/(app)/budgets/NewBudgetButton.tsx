'use client'

import { useRouter } from 'next/navigation'
import { Plus } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Button } from '@openbooks/ui'
import { mergeHref } from '../../../lib/list-params'

/**
 * Unsaved-create: opens a URL-controlled unsaved drawer (`?budgetNew=1`).
 * Zero writes on open — the budget is persisted only by the drawer's
 * explicit Save (POST /api/budgets/draft, then the entered lines). Opening
 * and abandoning the drawer leaves no budget row behind.
 */
export function NewBudgetButton({
  currentParams,
}: {
  currentParams: Record<string, string | string[] | undefined>
}) {
  const t = useTranslations('budgets')
  const router = useRouter()

  function open() {
    router.push((mergeHref('/budgets', currentParams, {
      budget: null,
      budgetNew: '1',
      budgetQ: null,
      budgetPage: null,
      budgetDepartment: null,
      budgetProject: null,
      budgetLocation: null,
      budgetClass: null,
      budgetImport: null,
      budgetView: null,
    })))
    router.refresh()
  }

  return <Button onClick={open}>
    <Plus size={16} />
    {t('list.new')}
  </Button>
}

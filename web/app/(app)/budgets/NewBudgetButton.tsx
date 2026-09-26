'use client'

import { useTranslations } from 'next-intl'
import { UnsavedCreateButton } from '@/components/unsaved-create-button'

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
  return (
    <UnsavedCreateButton
      base="/budgets"
      param="budgetNew"
      clear={[
        'budget',
        'budgetQ',
        'budgetPage',
        'budgetDepartment',
        'budgetProject',
        'budgetLocation',
        'budgetClass',
        'budgetImport',
        'budgetView',
      ]}
      label={t('list.new')}
      currentParams={currentParams}
    />
  )
}

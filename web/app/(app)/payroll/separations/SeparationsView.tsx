'use client'

import { useTranslations } from 'next-intl'
import type { YearEndFilingSection } from '@openbooks/engine/src/payroll/yearend.ts'
import { FilingWorkspace } from '../_ui/filing-workspace'

/**
 * Separations body: the shared filing workspace, showing only the packs'
 * separation-cadence filings — employees with an interruption of earnings
 * and their separation-filing status, each row opening the shared slip
 * drawer (facsimile + reason-for-issue declaration).
 */
export function SeparationsView({
  year,
  years,
  sections,
}: {
  year: number
  years: number[]
  sections: YearEndFilingSection[]
}) {
  const t = useTranslations('payroll.separations')
  return (
    <FilingWorkspace
      year={year}
      years={years}
      path="/payroll/separations"
      emptyTitle={t('noFilings')}
      groups={[{ key: 'separation', sections }]}
    />
  )
}

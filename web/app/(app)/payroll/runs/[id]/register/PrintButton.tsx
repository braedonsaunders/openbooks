'use client'

import { useTranslations } from 'next-intl'
import { Printer } from 'lucide-react'
import { Button } from '@openbooks/ui'

export function PrintButton() {
  const t = useTranslations('payroll.register')
  return (
    <Button variant="outline" onClick={() => window.print()}>
      <Printer size={14} aria-hidden /> {t('print')}
    </Button>
  )
}

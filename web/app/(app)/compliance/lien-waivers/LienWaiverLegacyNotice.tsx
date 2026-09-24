'use client'

import { useTranslations } from 'next-intl'
import { Alert, AlertDescription } from '@openbooks/ui'

export function LienWaiverLegacyNotice({ visible }: { visible: boolean }) {
  const t = useTranslations('compliance')
  if (!visible) return null

  return (
    <Alert className="mb-4" variant="destructive">
      <AlertDescription>
        <strong className="mr-1">{t('lienWaivers.legacyNotice.title')}</strong>
        {t('lienWaivers.legacyNotice.body')} {t('lienWaivers.legacyNotice.remedy')}
      </AlertDescription>
    </Alert>
  )
}

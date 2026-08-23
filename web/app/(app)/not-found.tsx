import Link from 'next/link'
import { FileQuestion } from 'lucide-react'
import { getTranslations } from 'next-intl/server'
import { Button } from '@openbooks/ui'
import { RouteStateView } from '@/components/route-state'

export default async function AppNotFound() {
  const t = await getTranslations('shell.routeState')

  return (
    <RouteStateView
      icon={<FileQuestion />}
      title={t('notFoundTitle')}
      description={t('notFoundDescription')}
      action={
        <Button asChild>
          <Link href="/dashboard">{t('backToDashboard')}</Link>
        </Button>
      }
    />
  )
}

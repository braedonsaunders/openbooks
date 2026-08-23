import Link from 'next/link'
import { FileQuestion } from 'lucide-react'
import { getTranslations } from 'next-intl/server'
import { Button } from '@openbooks/ui'
import { RouteStateStandalone } from '@/components/route-state'

/** Root not-found for routes outside the authenticated app shell. */
export default async function RootNotFound() {
  const t = await getTranslations('shell.routeState')

  return (
    <RouteStateStandalone
      icon={<FileQuestion />}
      title={t('notFoundTitle')}
      description={t('notFoundDescription')}
      action={
        <Button asChild>
          <Link href="/login">{t('backToSignIn')}</Link>
        </Button>
      }
    />
  )
}
